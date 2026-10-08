import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

// One SQLite file holds the SDK's A2A tables (created by `npm run db:migrate`)
// and the relay's own work queue and event log (created here).

export type WorkStatus = 'pending' | 'claimed' | 'done' | 'cancelled';

export interface WorkItem {
  id: string;
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

  constructor(path: string) {
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
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS work_items_status ON work_items (status, created_at);
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
        `INSERT INTO work_items (id, task_id, context_id, owner, customer_message_id, message_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (task_id, customer_message_id) DO NOTHING`,
      )
      .run(randomUUID(), item.task_id, item.context_id, item.owner, item.customer_message_id, item.message_json, Date.now());
    return this.sqlite
      .prepare(`SELECT * FROM work_items WHERE task_id = ? AND customer_message_id = ?`)
      .get(item.task_id, item.customer_message_id) as WorkItem;
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.sqlite.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItem | undefined;
  }

  /** Claims every pending item plus claimed items whose lease ran out. */
  claimAvailable(leaseMs: number): WorkItem[] {
    const now = Date.now();
    return this.sqlite.transaction(() => {
      const items = this.sqlite
        .prepare(
          `SELECT * FROM work_items
           WHERE status = 'pending' OR (status = 'claimed' AND claimed_at < ?)
           ORDER BY created_at`,
        )
        .all(now - leaseMs) as WorkItem[];
      const claim = this.sqlite.prepare(`UPDATE work_items SET status = 'claimed', claimed_at = ? WHERE id = ?`);
      for (const item of items) claim.run(now, item.id);
      return items.map((i) => ({ ...i, status: 'claimed' as const, claimed_at: now }));
    })();
  }

  countAvailable(leaseMs: number): number {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM work_items
         WHERE status = 'pending' OR (status = 'claimed' AND claimed_at < ?)`,
      )
      .get(Date.now() - leaseMs) as { n: number };
    return row.n;
  }

  /** Marks an item done exactly once. Returns false if it was already finished. */
  completeWorkItem(id: string, reply: unknown): boolean {
    const res = this.sqlite
      .prepare(`UPDATE work_items SET status = 'done', reply_json = ? WHERE id = ? AND status IN ('pending', 'claimed')`)
      .run(JSON.stringify(reply), id);
    return res.changes === 1;
  }

  cancelOpenItemsForTask(taskId: string): number {
    return this.sqlite
      .prepare(`UPDATE work_items SET status = 'cancelled' WHERE task_id = ? AND status IN ('pending', 'claimed')`)
      .run(taskId).changes;
  }

  countRepliesForTask(taskId: string): number {
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM work_items WHERE task_id = ? AND status = 'done'`)
      .get(taskId) as { n: number };
    return row.n;
  }

  hasOpenItemForTask(taskId: string): boolean {
    return !!this.sqlite
      .prepare(`SELECT 1 FROM work_items WHERE task_id = ? AND status IN ('pending', 'claimed')`)
      .get(taskId);
  }

  /** Pending items nobody has picked up and that were not rung recently. */
  itemsToRering(olderThanMs: number): WorkItem[] {
    const cutoff = Date.now() - olderThanMs;
    return this.sqlite
      .prepare(
        `SELECT * FROM work_items
         WHERE status = 'pending' AND created_at < ? AND COALESCE(last_rung_at, 0) < ? AND ring_count < 5`,
      )
      .all(cutoff, cutoff) as WorkItem[];
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
