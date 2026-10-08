import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type ErrorRequestHandler } from 'express';
import Database from 'better-sqlite3';
import { loadConfig, type RegistryConfig } from './config.js';
import { fetchPublicJson } from './remote.js';
import { HttpError, object, text, validateListing, validateCard, validateSearch, distanceKm, type Listing } from './validation.js';

export const MAX_BUSINESSES = 100;
export const HEALTH_TTL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
interface Row {
  id: string; publisher_id: string; website: string; data: string; status: 'pending' | 'active' | 'paused';
  challenge: string; revision: number; verified_at: number | null; last_checked_at: number | null; health_error: string | null;
}
export interface RegistryOptions {
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  startHealthTimer?: boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = (value: number | null) => value === null ? null : new Date(value).toISOString();
export function createRegistry(config: RegistryConfig, options: RegistryOptions = {}) {
  if (config.adminToken.length < 24) throw new Error('Registry administrator token must contain at least 24 characters');
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS publishers (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES publishers(id), website TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','active','paused')), challenge TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, last_checked_at INTEGER, health_error TEXT
    );
    CREATE INDEX IF NOT EXISTS businesses_publisher ON businesses(publisher_id);
  `);
  const now = options.now ?? Date.now;
  const fetchJson = options.fetchJson ?? fetchPublicJson;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const get = (id: string) => db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Row | undefined;
  const visible = (row: Row) => row.status === 'active' && row.verified_at !== null && row.health_error === null && row.last_checked_at !== null && row.last_checked_at > now() - HEALTH_TTL_MS;
  function view(row: Row, owner = false) {
    return {
      business_id: row.id, ...JSON.parse(row.data) as Listing, status: row.status,
      verified_at: timestamp(row.verified_at), last_checked_at: timestamp(row.last_checked_at),
      verification_scope: 'domain_control_and_card_metadata', capabilities_source: 'publisher_declared',
      ...(owner ? { health_error: row.health_error, verification: { url: `${row.website}/.well-known/business-registry-verification.json`, body: { business_id: row.id, challenge: row.challenge } } } : {}),
    };
  }
  function bearer(req: Request) {
    const value = req.get('authorization');
    if (!value?.startsWith('Bearer ') || value.length > 512) throw new HttpError(401, 'Bearer token required');
    return value.slice(7);
  }
  function publisher(req: Request): string {
    const row = db.prepare('SELECT id FROM publishers WHERE token_hash = ?').get(hash(bearer(req))) as { id: string } | undefined;
    if (!row) throw new HttpError(401, 'Invalid publisher token');
    return row.id;
  }
  function own(req: Request): Row {
    const id = publisher(req), row = get(String(req.params.id));
    if (!row || row.publisher_id !== id) throw new HttpError(404, 'Business not found');
    return row;
  }
  app.get('/', (_req, res) => res.json({ name: 'Business Agent Registry', version: '1', search: '/api/search', register: '/api/businesses', owner_listings: '/api/me/businesses', verification_scope: 'domain_control_and_card_metadata', capabilities_source: 'publisher_declared', health_ttl_seconds: HEALTH_TTL_MS / 1000 }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  app.get('/cli/registry.mjs', (_req, res) => res.type('text/javascript').sendFile(resolve(root, 'packages/agent-client/dist/registry.mjs')));
  app.get('/skills/business-registry/SKILL.md', (_req, res) => res.type('text/plain').sendFile(resolve(root, 'skills/business-registry/SKILL.md')));
  app.post('/api/publishers', (req, res) => {
    if (!timingSafeEqual(Buffer.from(hash(bearer(req))), Buffer.from(hash(config.adminToken)))) throw new HttpError(401, 'Invalid administrator token');
    const input = object(req.body);
    if (Object.keys(input).some(key => key !== 'name')) throw new HttpError(400, 'Unknown publisher field');
    const name = text(input.name, 'name'), id = randomUUID(), token = `publisher_${randomBytes(32).toString('base64url')}`;
    db.prepare('INSERT INTO publishers (id, name, token_hash) VALUES (?, ?, ?)').run(id, name, hash(token));
    res.status(201).json({ publisher_id: id, name, token });
  });
  app.post('/api/businesses', (req, res) => {
    const publisherId = publisher(req), listing = validateListing(req.body);
    const existing = db.prepare('SELECT * FROM businesses WHERE website = ?').get(listing.website) as Row | undefined;
    if (existing) {
      if (existing.publisher_id !== publisherId) throw new HttpError(409, 'Website already registered');
      res.json(view(existing, true)); return;
    }
    const count = db.prepare('SELECT COUNT(*) AS total FROM businesses').get() as { total: number };
    if (count.total >= MAX_BUSINESSES) throw new HttpError(409, 'Registry capacity reached (100 businesses)');
    const id = randomUUID();
    db.prepare("INSERT INTO businesses (id,publisher_id,website,data,status,challenge) VALUES (?,?,?,?,'pending',?)").run(id, publisherId, listing.website, JSON.stringify(listing), randomBytes(32).toString('base64url'));
    res.status(201).json(view(get(id)!, true));
  });
  app.get('/api/me/businesses', (req, res) => {
    const rows = db.prepare('SELECT * FROM businesses WHERE publisher_id = ? ORDER BY id').all(publisher(req)) as Row[];
    res.json({ businesses: rows.map(row => view(row, true)) });
  });
  app.get('/api/businesses/:id', (req, res) => {
    const row = get(String(req.params.id));
    if (!row || !visible(row)) throw new HttpError(404, 'Business not found');
    res.json(view(row));
  });
  app.patch('/api/businesses/:id', (req, res) => {
    const row = own(req), listing = validateListing(req.body, JSON.parse(row.data));
    const other = db.prepare('SELECT id FROM businesses WHERE website = ? AND id != ?').get(listing.website, row.id);
    if (other) throw new HttpError(409, 'Website already registered');
    db.prepare(`UPDATE businesses SET website=?,data=?,status=?,challenge=?,revision=revision+1,verified_at=NULL,last_checked_at=NULL,health_error=NULL WHERE id=?`).run(listing.website, JSON.stringify(listing), row.status === 'paused' ? 'paused' : 'pending', randomBytes(32).toString('base64url'), row.id);
    res.json(view(get(row.id)!, true));
  });
  app.post('/api/businesses/:id/pause', (req, res) => {
    const row = own(req);
    db.prepare("UPDATE businesses SET status='paused',revision=revision+1 WHERE id=?").run(row.id);
    res.json(view(get(row.id)!, true));
  });
  const inFlight = new Map<string, Promise<Row>>();
  let closed = false;
  async function performCheck(row: Row, activate: boolean): Promise<Row> {
    const key = `${row.id}:${row.revision}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      try {
        const challenge = object(await fetchJson(`${row.website}/.well-known/business-registry-verification.json`));
        if (challenge.business_id !== row.id || challenge.challenge !== row.challenge) throw new Error('Website ownership challenge does not match');
        validateCard(await fetchJson((JSON.parse(row.data) as Listing).agent_card_url), JSON.parse(row.data));
        if (closed) throw new HttpError(503, 'Registry is shutting down');
        const result = db.prepare('UPDATE businesses SET verified_at=?,last_checked_at=?,health_error=NULL,status=? WHERE id=? AND revision=?').run(now(), now(), activate ? 'active' : row.status, row.id, row.revision);
        if (!result.changes) throw new HttpError(409, 'Business changed during verification; retry');
        return get(row.id)!;
      } catch (error) {
        if (!closed && !(error instanceof HttpError && error.status === 409)) db.prepare('UPDATE businesses SET last_checked_at=?,health_error=? WHERE id=? AND revision=?').run(now(), 'Ownership or Agent Card validation failed', row.id, row.revision);
        if (error instanceof HttpError && [409, 503].includes(error.status)) throw error;
        throw new HttpError(422, 'Ownership or Agent Card validation failed; check the published challenge and A2A 1.0 card');
      }
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { inFlight.delete(key); }
  }
  app.post('/api/businesses/:id/verify', async (req, res) => {
    const row = own(req);
    // Explicit verify also resumes a paused listing; background checks never do.
    res.json(view(await performCheck(row, true), true));
  });
  app.post('/api/businesses/:id/check', async (req, res) => {
    const row = own(req);
    if (row.status !== 'active' || row.verified_at === null) throw new HttpError(409, 'Only verified active businesses can be checked');
    res.json(view(await performCheck(row, false), true));
  });
  app.get('/api/search', (req, res) => {
    const search = validateSearch(req.query);
    const rows = db.prepare("SELECT * FROM businesses WHERE status='active' ORDER BY id").all() as Row[];
    const found = rows.filter(visible).map(row => {
      const listing = view(row);
      return { ...listing, ...(search.lat !== undefined && search.lon !== undefined ? { distance_km: distanceKm(search.lat, search.lon, listing.location) } : {}) };
    }).filter(listing => (!search.service || listing.services.includes(search.service)) && (!search.action || listing.actions.includes(search.action)) && (!search.q || `${listing.name} ${listing.description} ${listing.location.address}`.toLowerCase().includes(search.q.toLowerCase())) && (search.radius === undefined || listing.distance_km! <= search.radius));
    if (search.lat !== undefined) found.sort((a, b) => a.distance_km! - b.distance_km! || a.business_id.localeCompare(b.business_id));
    res.json({ businesses: found.slice(search.offset, search.offset + search.limit), total: found.length, limit: search.limit, offset: search.offset });
  });
  let checking = false;
  async function checkHealth() {
    if (checking || closed) return;
    checking = true;
    try {
      const rows = db.prepare("SELECT * FROM businesses WHERE status='active' ORDER BY COALESCE(last_checked_at,0),id LIMIT 20").all() as Row[];
      for (const row of rows) { if (closed) break; try { await performCheck(row, false); } catch { /* Unhealthy listings are hidden until a successful check. */ } }
    } finally { checking = false; }
  }
  const timer = options.startHealthTimer === false ? undefined : setInterval(() => { void checkHealth(); }, CHECK_INTERVAL_MS);
  timer?.unref();
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : error?.status === 400 ? 400 : error?.status === 413 ? 413 : error?.status === 404 ? 404 : 500;
    res.status(status).json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid JSON' : status === 413 ? 'Request too large' : status === 404 ? 'Not found' : 'Internal server error' });
  };
  app.use(errors);
  return { app, config, checkHealth, close() { closed = true; if (timer) clearInterval(timer); db.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = createRegistry(loadConfig());
  const server = registry.app.listen(registry.config.port, registry.config.host, () => console.log(`Business registry listening on ${registry.config.host}:${registry.config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(() => registry.close()); });
}
