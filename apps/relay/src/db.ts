import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { AcceptedReply, Identity } from './config.js';

// One SQLite file holds the SDK's A2A tables (created by `npm run db:migrate`)
// and the relay's own work queue and event log (created here).

export type WorkStatus = 'pending' | 'claimed' | 'done' | 'cancelled';

export interface WorkItem {
  id: string;
  business_id: string;
  claimed_by_connection_id: string | null;
  claim_epoch: number | null;
  claim_generation: number;
  lease_token_hash: string | null;
  lease_until: number | null;
  /** Returned only when claimed; never persisted in plaintext. */
  lease_token?: string;
  task_id: string;
  context_id: string;
  owner: string;
  customer_message_id: string;
  /** Summary of the customer message this item answers; the task may not be persisted yet when claimed. */
  message_json: string;
  status: WorkStatus;
  created_at: number;
  claimed_at: number | null;
  last_rung_at: number | null;
  ring_count: number;
  reply_json: string | null;
}

export interface RelayEvent {
  id: number;
  at: string;
  task_id: string | null;
  actor: string;
  kind: string;
  detail: unknown;
}

export class RelayDb {
  readonly sqlite: Database.Database;
  readonly kysely: Kysely<unknown>;

  constructor(path: string, readonly businessId = 'standalone') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.kysely = new Kysely({ dialect: new SqliteDialect({ database: this.sqlite }) });
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        customer_message_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        last_rung_at INTEGER,
        ring_count INTEGER NOT NULL DEFAULT 0,
        reply_json TEXT,
        UNIQUE (task_id, customer_message_id)
      );
    `);
    // Databases created before message_json existed (first Railway deploy) get the column added.
    const cols = this.sqlite.prepare(`PRAGMA table_info(work_items)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'message_json')) {
      this.sqlite.exec(`ALTER TABLE work_items ADD COLUMN message_json TEXT NOT NULL DEFAULT '{}'`);
    }
    const additions: Record<string, string> = {
      business_id: "TEXT NOT NULL DEFAULT 'standalone'",
      claimed_by_connection_id: 'TEXT', claim_epoch: 'INTEGER',
      claim_generation: 'INTEGER NOT NULL DEFAULT 0', lease_token_hash: 'TEXT', lease_until: 'INTEGER',
    };
    for (const [name, type] of Object.entries(additions)) {
      if (!cols.some((c) => c.name === name)) this.sqlite.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS work_items_status ON work_items (status, created_at);
      CREATE TABLE IF NOT EXISTS reply_outbox (
        work_item_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        code_hash TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        role TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS issued_tokens (
        token_hash TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        task_id TEXT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
    `);
    const bound = this.getSetting('business_id');
    const nativeMigration = businessId === 'pneu007' && (!bound || bound === 'standalone');
    const existingBusinesses = this.sqlite.prepare('SELECT DISTINCT business_id FROM work_items').all() as { business_id: string }[];
    if ((bound && bound !== businessId && !nativeMigration)
      || existingBusinesses.some((row) => row.business_id !== businessId && !(nativeMigration && row.business_id === 'standalone'))) {
      this.sqlite.close();
      throw new Error('Relay database belongs to another business');
    }
    this.sqlite.transaction(() => {
      if (nativeMigration) {
        this.sqlite.prepare("UPDATE work_items SET business_id = 'pneu007' WHERE business_id = 'standalone'").run();
        const replies = this.sqlite.prepare('SELECT work_item_id,payload_json FROM reply_outbox').all() as {work_item_id:string;payload_json:string}[];
        for (const row of replies) {
          const record = JSON.parse(row.payload_json) as AcceptedReply;
          if (record.business_id !== 'standalone' && record.business_id !== 'pneu007') throw new Error('Relay reply belongs to another business');
          record.business_id = 'pneu007';
          this.sqlite.prepare('UPDATE reply_outbox SET payload_json = ? WHERE work_item_id = ?').run(JSON.stringify(record), row.work_item_id);
        }
      }
      this.setSetting('business_id', businessId);
    })();

  }

  assertA2aTables() {
    const row = this.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
    if (!row) throw new Error('A2A tables missing. Run `npm run db:migrate -w @pneu007/relay` first.');
  }

  /** Inserts a work item, or returns the existing one for a re-delivered customer message. */
  createWorkItem(
    item: Pick<WorkItem, 'task_id' | 'context_id' | 'owner' | 'customer_message_id' | 'message_json'>,
  ): WorkItem {
    this.sqlite
      .prepare(
        `INSERT INTO work_items (id, business_id, task_id, context_id, owner, customer_message_id, message_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (task_id, customer_message_id) DO NOTHING`,
      )
      .run(randomUUID(), this.businessId, item.task_id, item.context_id, item.owner, item.customer_message_id, item.message_json, Date.now());
    return this.sqlite
      .prepare(`SELECT * FROM work_items WHERE business_id = ? AND task_id = ? AND customer_message_id = ?`)
      .get(this.businessId, item.task_id, item.customer_message_id) as WorkItem;
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.sqlite.prepare(`SELECT * FROM work_items WHERE id = ? AND business_id = ?`).get(id, this.businessId) as WorkItem | undefined;
  }

  /** Managed claims have opaque, expiring fences. Only the current connection can renew work. */
  claimAvailable(leaseMs: number, identity?: Identity): WorkItem[] {
    const now = Date.now();
    return this.sqlite.transaction(() => {
      const managed = this.businessId !== 'standalone';
      if (managed && (!identity?.connection_id || identity.business_id !== this.businessId || identity.execution_epoch === undefined)) {
        throw new Error('managed claim requires a business connection and epoch');
      }
      if (managed) {
        // A handover need not wait for old leases to expire. Authority was checked by the caller.
        this.sqlite.prepare(`UPDATE work_items SET status = 'pending' WHERE business_id = ? AND status = 'claimed'
          AND (claimed_by_connection_id IS NOT ? OR claim_epoch IS NOT ?)`)
          .run(this.businessId, identity!.connection_id!, identity!.execution_epoch!);
      }
      if (managed && this.sqlite.prepare(`SELECT 1 FROM work_items WHERE business_id = ? AND status = 'claimed'
        AND claimed_by_connection_id = ? AND claim_epoch = ? AND lease_until > ? LIMIT 1`)
        .get(this.businessId, identity!.connection_id!, identity!.execution_epoch!, now)) return [];
      const items = this.sqlite.prepare(`SELECT * FROM work_items WHERE business_id = ?
        AND (status = 'pending' OR (status = 'claimed' AND COALESCE(lease_until, claimed_at + ?) <= ?))
        ORDER BY created_at LIMIT ?`).all(this.businessId, leaseMs, now, managed ? 1 : -1) as WorkItem[];
      const update = this.sqlite.prepare(`UPDATE work_items SET status = 'claimed', claimed_at = ?,
        claimed_by_connection_id = ?, claim_epoch = ?, claim_generation = claim_generation + 1,
        lease_token_hash = ?, lease_until = ? WHERE id = ? AND business_id = ?`);
      return items.map((item) => {
        const leaseToken = randomBytes(32).toString('base64url');
        update.run(now, identity?.connection_id ?? null, identity?.execution_epoch ?? null,
          tokenHash(leaseToken), now + leaseMs, item.id, this.businessId);
        return { ...item, status: 'claimed' as const, claimed_at: now,
          claimed_by_connection_id: identity?.connection_id ?? null, claim_epoch: identity?.execution_epoch ?? null,
          claim_generation: item.claim_generation + 1, lease_token_hash: tokenHash(leaseToken),
          lease_until: now + leaseMs, lease_token: managed ? leaseToken : undefined };
      });
    })();
  }

  countAvailable(leaseMs: number, identity?: Identity): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE business_id = ?
      AND (status = 'pending' OR (status = 'claimed' AND (COALESCE(lease_until, claimed_at + ?) <= ?
        OR (? IS NOT NULL AND (claimed_by_connection_id IS NOT ? OR claim_epoch IS NOT ?)))))`)
      .get(this.businessId, leaseMs, Date.now(), identity?.connection_id ?? null,
        identity?.connection_id ?? null, identity?.execution_epoch ?? null) as { n: number };
    return row.n;
  }

  validLease(item: WorkItem, identity: Identity, leaseToken: unknown, generation: unknown): boolean {
    return item.business_id === this.businessId && item.status === 'claimed'
      && item.claimed_by_connection_id === identity.connection_id && item.claim_epoch === identity.execution_epoch
      && item.lease_until !== null && item.lease_until > Date.now()
      && typeof leaseToken === 'string' && tokenHash(leaseToken) === item.lease_token_hash
      && generation === item.claim_generation;
  }

  /** Full payload and delivery intent are one transaction; a crash never reoffers accepted work. */
  storeAcceptedReply(record: AcceptedReply): boolean {
    if (record.business_id !== this.businessId) throw new Error('reply belongs to another business');
    return this.sqlite.transaction(() => {
      const result = this.sqlite.prepare(`UPDATE work_items SET status = 'done', reply_json = ?
        WHERE id = ? AND business_id = ? AND status IN ('pending','claimed')`)
        .run(JSON.stringify(record.reply), record.work_item_id, this.businessId);
      if (result.changes !== 1 && !this.getWorkItem(record.work_item_id)) throw new Error('unknown work item');
      this.sqlite.prepare(`INSERT INTO reply_outbox (work_item_id, payload_json, created_at)
        VALUES (?, ?, ?) ON CONFLICT(work_item_id) DO NOTHING`)
        .run(record.work_item_id, JSON.stringify(record), Date.now());
      return result.changes === 1;
    })();
  }

  pendingReplies(): AcceptedReply[] {
    return (this.sqlite.prepare(`SELECT payload_json FROM reply_outbox WHERE delivered_at IS NULL ORDER BY created_at`)
      .all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json));
  }

  /** Keep accepted state protected from delayed SDK progress writes even after acknowledgement. */
  latestAcceptedReplyForTask(taskId: string): { record: AcceptedReply; delivered: boolean } | undefined {
    const row = this.sqlite.prepare(`SELECT o.payload_json, o.delivered_at FROM work_items w
      JOIN reply_outbox o ON o.work_item_id = w.id WHERE w.id =
        (SELECT id FROM work_items WHERE task_id = ? AND business_id = ? ORDER BY rowid DESC LIMIT 1)
      AND w.status = 'done'`).get(taskId, this.businessId) as { payload_json: string; delivered_at: number | null } | undefined;
    return row ? { record: JSON.parse(row.payload_json), delivered: row.delivered_at !== null } : undefined;
  }

  markReplyDelivered(id: string) {
    this.sqlite.prepare(`UPDATE reply_outbox SET delivered_at = ? WHERE work_item_id = ? AND delivered_at IS NULL`)
      .run(Date.now(), id);
  }

  /** Compatibility method retained for existing internal callers. */
  completeWorkItem(id: string, reply: unknown): boolean {
    return this.sqlite.prepare(`UPDATE work_items SET status = 'done', reply_json = ?
      WHERE id = ? AND business_id = ? AND status IN ('pending','claimed')`)
      .run(JSON.stringify(reply), id, this.businessId).changes === 1;
  }

  cancelOpenItemsForTask(taskId: string): number {
    return this.sqlite
      .prepare(`UPDATE work_items SET status = 'cancelled' WHERE task_id = ? AND business_id = ? AND status IN ('pending', 'claimed')`)
      .run(taskId, this.businessId).changes;
  }

  countRepliesForTask(taskId: string): number {
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM work_items WHERE task_id = ? AND business_id = ? AND status = 'done'`)
      .get(taskId, this.businessId) as { n: number };
    return row.n;
  }

  hasOpenItemForTask(taskId: string): boolean {
    return !!this.sqlite
      .prepare(`SELECT 1 FROM work_items WHERE task_id = ? AND business_id = ? AND status IN ('pending', 'claimed')`)
      .get(taskId, this.businessId);
  }

  /** Pending items nobody has picked up and that were not rung recently. */
  itemsToRering(olderThanMs: number): WorkItem[] {
    const cutoff = Date.now() - olderThanMs;
    return this.sqlite
      .prepare(
        `SELECT * FROM work_items
         WHERE business_id = ? AND status = 'pending' AND created_at < ? AND COALESCE(last_rung_at, 0) < ? AND ring_count < 5`,
      )
      .all(this.businessId, cutoff, cutoff) as WorkItem[];
  }

  markRung(ids: string[]) {
    const stmt = this.sqlite.prepare(
      `UPDATE work_items SET last_rung_at = ?, ring_count = ring_count + 1 WHERE id = ?`,
    );
    const now = Date.now();
    this.sqlite.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  createEnrollment(codeHash: string, identityId: string, role: string, expiresAt: number) {
    this.sqlite
      .prepare(`INSERT INTO enrollments (code_hash, identity_id, role, expires_at) VALUES (?, ?, ?, ?)`)
      .run(codeHash, identityId, role, expiresAt);
  }

  /** Burns a valid enrollment code and stores the hash of the token issued for it. One use only. */
  redeemEnrollment(codeHash: string, tokenHash: string): { identity_id: string; role: string } | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(`SELECT identity_id, role FROM enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
        .get(codeHash, Date.now()) as { identity_id: string; role: string } | undefined;
      if (!row) return undefined;
      this.sqlite.prepare(`UPDATE enrollments SET used_at = ? WHERE code_hash = ?`).run(Date.now(), codeHash);
      this.sqlite
        .prepare(`INSERT INTO issued_tokens (token_hash, identity_id, role, created_at) VALUES (?, ?, ?, ?)`)
        .run(tokenHash, row.identity_id, row.role, Date.now());
      return row;
    })();
  }

  lookupIssuedToken(tokenHash: string): { identity_id: string; role: string } | undefined {
    return this.sqlite
      .prepare(`SELECT identity_id, role FROM issued_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(tokenHash) as { identity_id: string; role: string } | undefined;
  }

  getSetting(key: string): string | undefined {
    return (this.sqlite.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string | undefined) {
    if (value === undefined) this.sqlite.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
    else this.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  logEvent(e: { task_id?: string | null; actor: string; kind: string; detail?: unknown }) {
    this.sqlite
      .prepare(`INSERT INTO events (at, task_id, actor, kind, detail_json) VALUES (?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), e.task_id ?? null, e.actor, e.kind, JSON.stringify(e.detail ?? {}));
  }

  listEvents(opts: { taskId?: string; afterId?: number; limit?: number }): RelayEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM events WHERE (? IS NULL OR task_id = ?) AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(opts.taskId ?? null, opts.taskId ?? null, opts.afterId ?? 0, opts.limit ?? 500) as Array<
      Omit<RelayEvent, 'detail'> & { detail_json: string }
    >;
    return rows.map(({ detail_json, ...r }) => ({ ...r, detail: JSON.parse(detail_json) }));
  }
}

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
