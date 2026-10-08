import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';
import { type Actor } from '../../../packages/contracts/index.js';
import type { LegacyAuth } from './auth.js';

const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim';
const PRE_SCOPES = ['agent.identity'];
const SCOPES = ['agent.identity', 'a2a', 'customer.tools'];
const CLAIM_TTL = 10 * 60_000;
const ACCESS_TTL = 60 * 60_000;
const ASSERTION_TTL = 24 * 60 * 60_000;
const REGISTRATION_TTL = 24 * 60 * 60_000;
const CLAIMED_TTL = 30 * 24 * 60 * 60_000;
const POLL_INTERVAL = 5;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const iso = (time: number) => new Date(time).toISOString();

interface Registration {
  id: string;
  type: 'anonymous' | 'service_auth';
  status: 'unclaimed' | 'claimed' | 'expired' | 'revoked';
  claim_hash: string;
  claim_email: string | null;
  customer_id: string | null;
  created_at: number;
  expires_at: number;
  version: number;
  claim_delivered: number;
}
interface ClaimAttempt {
  id: string;
  registration_id: string;
  token_hash: string;
  code_hash: string;
  expires_at: number;
  failures: number;
  last_poll_at: number | null;
}
class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
function invalid(message = 'Invalid request.'): never { throw new OAuthError('invalid_request', message); }
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max) invalid();
  return value;
}
function email(value: unknown): string {
  const normalized = text(value, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) invalid('Supply a valid email address.');
  return normalized;
}

/** Service-owned agent identities; customer delegation requires a signed-in human claim. */
export class AgentAuth {
  private readonly now: () => Date;
  private readonly issuer: string;
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;

  constructor(readonly db: Database.Database, options: { publicUrl: string; now?: () => Date }) {
    const url = new URL(options.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Agent authentication requires an absolute public origin URL.');
    }
    this.issuer = url.origin;
    this.now = options.now ?? (() => new Date());
    // SQLite holds the signing key: protect its main file and any existing journals before writing it.
    if (!db.memory) {
      chmodSync(db.name, 0o600);
      for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(`${db.name}${suffix}`)) chmodSync(`${db.name}${suffix}`, 0o600);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS agent_auth_keys(id TEXT PRIMARY KEY,private_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_auth_registrations(
        id TEXT PRIMARY KEY,type TEXT NOT NULL,status TEXT NOT NULL,claim_hash TEXT NOT NULL UNIQUE,
        claim_email TEXT,customer_id TEXT REFERENCES customers(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,claim_delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS agent_auth_customer ON agent_auth_registrations(customer_id);
      CREATE TABLE IF NOT EXISTS agent_auth_claim_attempts(
        id TEXT PRIMARY KEY,registration_id TEXT NOT NULL UNIQUE REFERENCES agent_auth_registrations(id),
        token_hash TEXT NOT NULL UNIQUE,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,last_poll_at INTEGER);
      CREATE TABLE IF NOT EXISTS agent_auth_access_tokens(
        token_hash TEXT PRIMARY KEY,registration_id TEXT NOT NULL REFERENCES agent_auth_registrations(id),
        version INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS agent_auth_token_registration ON agent_auth_access_tokens(registration_id);
      CREATE TABLE IF NOT EXISTS agent_auth_assertion_uses(jti TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_auth_rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS agent_auth_immutable_customer BEFORE UPDATE OF customer_id ON agent_auth_registrations
        WHEN OLD.customer_id IS NOT NULL AND (NEW.customer_id IS NULL OR NEW.customer_id != OLD.customer_id)
        BEGIN SELECT RAISE(ABORT,'Agent customer binding is immutable'); END;`);
    const stored = db.prepare('SELECT private_key FROM agent_auth_keys WHERE id=?').get('ed25519-v1') as { private_key: string } | undefined;
    if (!stored) {
      const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      db.prepare('INSERT OR IGNORE INTO agent_auth_keys VALUES(?,?)').run('ed25519-v1', generated);
    }
    const persisted = db.prepare('SELECT private_key FROM agent_auth_keys WHERE id=?').get('ed25519-v1') as { private_key: string };
    this.key = createPrivateKey(persisted.private_key);
    this.publicKey = createPublicKey(this.key);
    this.keyId = hash(this.publicKey.export({ format: 'pem', type: 'spki' }).toString()).slice(0, 24);
  }

  identify(token: string): Actor | undefined {
    if (typeof token !== 'string' || token.length > 200 || !token.startsWith('agt_')) return;
    const row = this.db.prepare(`SELECT r.* FROM agent_auth_access_tokens t JOIN agent_auth_registrations r ON r.id=t.registration_id
      WHERE t.token_hash=? AND t.expires_at>? AND t.revoked=0 AND t.version=r.version`).get(hash(token), this.time()) as Registration | undefined;
    if (!row || !this.active(row)) return;
    return { id: row.id, role: row.customer_id ? 'customer_agent' : 'unclaimed_agent', ...(row.customer_id ? { customer_id: row.customer_id } : {}) };
  }

  router(auth: LegacyAuth): express.Router {
    const router = express.Router();
    const json = express.json({ limit: '8kb' });
    const form = express.urlencoded({ extended: false, limit: '12kb', parameterLimit: 5 });
    const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
      res.set('Cache-Control', 'no-store');
      try { fn(req, res); } catch (error) {
        if (error instanceof OAuthError) {
          if (error.status === 401) res.set('WWW-Authenticate', `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"`);
          if (error.status === 429) res.set('Retry-After', '60');
          res.status(error.status).json({ error: error.code, error_description: error.message });
        } else next(error);
      }
    };
    const human = (req: Request, _res: Response, next: NextFunction) => {
      if (!req.legacySession || req.header('authorization') || req.legacyActor?.role !== 'human_customer' || !req.legacyActor.customer_id) {
        return next(new OAuthError('access_denied', 'A signed-in human customer is required.', 403));
      }
      next();
    };
    router.get('/auth.md', (_req, res) => res.set('Cache-Control', 'no-store').type('text/markdown').send(this.authDocument()));
    router.get('/.well-known/oauth-protected-resource', (_req, res) => res.set('Cache-Control', 'no-store').json({
      resource: this.issuer, resource_name: 'Pneu 007', authorization_servers: [this.issuer],
      scopes_supported: SCOPES, bearer_methods_supported: ['header'],
    }));
    router.get('/.well-known/oauth-authorization-server', (_req, res) => res.set('Cache-Control', 'no-store').json({
      issuer: this.issuer, token_endpoint: `${this.issuer}/oauth2/token`, revocation_endpoint: `${this.issuer}/oauth2/revoke`,
      grant_types_supported: [JWT_GRANT, CLAIM_GRANT], token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES,
      agent_auth: { skill: `${this.issuer}/auth.md`, identity_endpoint: `${this.issuer}/agent/identity`,
        claim_endpoint: `${this.issuer}/agent/identity/claim`, identity_types_supported: ['anonymous', 'service_auth'] },
    }));
    router.post('/agent/identity', json, handle((req, res) => {
      this.limit(req, 'register', 20, 60 * 60_000);
      const input = body(req.body, ['type', 'login_hint']);
      if (input.type !== 'anonymous' && input.type !== 'service_auth') invalid('Supported registration types: anonymous, service_auth.');
      if (input.type === 'anonymous' && input.login_hint !== undefined) invalid();
      const claimEmail = input.type === 'service_auth' ? email(input.login_hint) : null;
      const now = this.time(), claimToken = secret('clm');
      const row: Registration = { id: secret('reg'), type: input.type, status: 'unclaimed', claim_hash: hash(claimToken),
        claim_email: claimEmail, customer_id: null, created_at: now, expires_at: now + REGISTRATION_TTL, version: 1, claim_delivered: 0 };
      const result = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO agent_auth_registrations(id,type,status,claim_hash,claim_email,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
          .run(row.id, row.type, row.status, row.claim_hash, row.claim_email, now, row.expires_at);
        this.audit(row.id, 'registration.created', row.id, { registration_type: row.type, ip: req.ip });
        const common = { registration_id: row.id, registration_type: row.type, claim_url: `${this.issuer}/agent/identity/claim`,
          claim_token: claimToken, claim_token_expires: iso(row.expires_at), post_claim_scopes: SCOPES };
        if (row.type === 'anonymous') return { ...common, ...this.assertion(row), pre_claim_scopes: PRE_SCOPES };
        return { ...common, claim: this.startAttempt(row, req).claim };
      }).immediate();
      res.status(201).json(result);
    }));
    router.post('/agent/identity/claim', json, handle((req, res) => {
      this.limit(req, 'claim', 20, 15 * 60_000);
      const input = body(req.body, ['claim_token', 'email']);
      const claimToken = text(input.claim_token), claimEmail = email(input.email);
      this.limit(req, `claim-token:${hash(claimToken)}`, 5, 15 * 60_000);
      const row = this.byClaim(claimToken);
      if (!row || !this.active(row)) throw new OAuthError('invalid_claim_token', 'Claim is unavailable.');
      if (row.type !== 'anonymous' || row.status !== 'unclaimed') throw new OAuthError('claimed_or_in_flight', 'Claim is unavailable.');
      const previous = this.attempt(row.id);
      if (previous && previous.expires_at > this.time()) throw new OAuthError('claimed_or_in_flight', 'Claim is unavailable.');
      const result = this.db.transaction(() => {
        this.db.prepare('UPDATE agent_auth_registrations SET claim_email=? WHERE id=? AND status=?').run(claimEmail, row.id, 'unclaimed');
        row.claim_email = claimEmail;
        const started = this.startAttempt(row, req);
        return { registration_id: row.id, claim_attempt_id: started.id, status: 'initiated', expires_at: iso(started.expiresAt), claim_attempt: started.claim };
      }).immediate();
      res.json(result);
    }));
    router.post('/oauth2/token', form, handle((req, res) => {
      this.limit(req, 'token', 120, 60_000);
      const input = body(req.body, ['grant_type', 'assertion', 'claim_token']);
      if (input.grant_type === JWT_GRANT) {
        if (input.claim_token !== undefined) invalid();
        const assertion = text(input.assertion, 8192);
        res.json(this.db.transaction(() => this.exchange(assertion, req)).immediate());
      } else if (input.grant_type === CLAIM_GRANT) {
        if (input.assertion !== undefined) invalid();
        res.json(this.poll(text(input.claim_token), req));
      } else throw new OAuthError('unsupported_grant_type', 'Unsupported grant type.');
    }));
    router.post('/oauth2/revoke', form, handle((req, res) => {
      this.limit(req, 'revoke', 60, 60_000);
      const input = body(req.body, ['token', 'token_type_hint']);
      const token = text(input.token, 8192);
      const row = this.db.prepare('SELECT registration_id FROM agent_auth_access_tokens WHERE token_hash=? AND revoked=0').get(hash(token)) as { registration_id: string } | undefined;
      if (row) {
        this.db.prepare('UPDATE agent_auth_access_tokens SET revoked=1 WHERE token_hash=?').run(hash(token));
        this.audit(row.registration_id, 'credential.revoked', row.registration_id, { ip: req.ip });
      }
      res.status(200).end();
    }));
    router.get('/api/agent/identity', auth.middleware, handle((req, res) => {
      const actor = req.legacyActor;
      if (!actor) throw new OAuthError('invalid_token', 'Agent credential required.', 401);
      if (!['unclaimed_agent', 'customer_agent', 'business_agent', 'owner_agent'].includes(actor.role)) throw new OAuthError('access_denied', 'Agent credential required.', 403);
      res.json({ agent: { id: actor.id, role: actor.role }, acting_for: actor.customer_id ? { type: 'customer', id: actor.customer_id } : null });
    }));
    router.get('/api/agent/identity/claim-request', auth.middleware, human, handle((req, res) => {
      const { row, attempt } = this.humanClaim(req, text(req.query.claim_attempt_token));
      res.json({ registration_id: row.id, registration_type: row.type, scopes: SCOPES, expires_at: iso(attempt.expires_at) });
    }));
    router.post('/api/agent/identity/confirm', json, auth.middleware, auth.protect, human, handle((req, res) => {
      this.limit(req, 'confirm', 30, 15 * 60_000);
      const input = body(req.body, ['claim_attempt_token', 'user_code']);
      const claimToken = text(input.claim_attempt_token), code = text(input.user_code, 6);
      const { row, attempt } = this.humanClaim(req, claimToken);
      if (!/^\d{6}$/.test(code) || !equal(hash(`${row.id}:${code}`), attempt.code_hash)) {
        this.db.prepare('UPDATE agent_auth_claim_attempts SET failures=failures+1 WHERE id=?').run(attempt.id);
        this.audit(row.id, 'claim.failed', req.legacyActor!.id, { ip: req.ip });
        throw new OAuthError('access_denied', 'Claim is unavailable or code is invalid.', 403);
      }
      this.db.transaction(() => {
        // Recheck both the authenticated account and ceremony state at the write boundary.
        this.humanClaim(req, claimToken);
        this.db.prepare(`UPDATE agent_auth_registrations SET status='claimed',customer_id=?,version=version+1,expires_at=? WHERE id=? AND status='unclaimed'`)
          .run(req.legacyActor!.customer_id, this.time() + CLAIMED_TTL, row.id);
        this.db.prepare('UPDATE agent_auth_access_tokens SET revoked=1 WHERE registration_id=?').run(row.id);
        this.audit(row.id, 'claim.confirmed', req.legacyActor!.id, { customer_id: req.legacyActor!.customer_id, ip: req.ip });
      }).immediate();
      res.json({ registration_id: row.id, status: 'claimed', acting_for: { type: 'customer', id: req.legacyActor!.customer_id } });
    }));
    router.get('/api/agent/identities', auth.middleware, human, handle((req, res) => {
      const rows = this.db.prepare('SELECT * FROM agent_auth_registrations WHERE customer_id=? ORDER BY created_at DESC LIMIT 100').all(req.legacyActor!.customer_id) as Registration[];
      res.json({ identities: rows.map(row => {
        this.active(row);
        return { registration_id: row.id, agent_id: row.id, status: row.status, created_at: iso(row.created_at), expires_at: iso(row.expires_at) };
      }) });
    }));
    router.post('/api/agent/identities/:id/revoke', json, auth.middleware, auth.protect, human, handle((req, res) => {
      body(req.body ?? {}, []);
      const id = text(req.params.id);
      const row = this.db.prepare('SELECT * FROM agent_auth_registrations WHERE id=? AND customer_id=?').get(id, req.legacyActor!.customer_id) as Registration | undefined;
      if (!row) throw new OAuthError('access_denied', 'Agent identity is unavailable.', 404);
      this.db.transaction(() => {
        this.db.prepare("UPDATE agent_auth_registrations SET status='revoked' WHERE id=?").run(id);
        this.db.prepare('UPDATE agent_auth_access_tokens SET revoked=1 WHERE registration_id=?').run(id);
        this.audit(id, 'registration.revoked', req.legacyActor!.id, { ip: req.ip });
      }).immediate();
      res.json({ registration_id: id, status: 'revoked' });
    }));
    router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
      if (error instanceof OAuthError) return res.status(error.status).set('Cache-Control', 'no-store').json({ error: error.code, error_description: error.message });
      if (['/agent/identity', '/agent/identity/claim', '/oauth2/token', '/oauth2/revoke'].includes(req.path)
        && error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'entity.too.large', 'parameters.too.many'].includes(String(error.type))) {
        const status = error.type === 'entity.too.large' ? 413 : 400;
        return res.status(status).set('Cache-Control', 'no-store').json({ error: 'invalid_request', error_description: 'Invalid or oversized request body.' });
      }
      next(error);
    });
    return router;
  }

  private time() { return this.now().getTime(); }
  private get(id: string) { return this.db.prepare('SELECT * FROM agent_auth_registrations WHERE id=?').get(id) as Registration | undefined; }
  private byClaim(token: string) { return this.db.prepare('SELECT * FROM agent_auth_registrations WHERE claim_hash=?').get(hash(token)) as Registration | undefined; }
  private attempt(id: string) { return this.db.prepare('SELECT * FROM agent_auth_claim_attempts WHERE registration_id=?').get(id) as ClaimAttempt | undefined; }
  private active(row: Registration) {
    if (['revoked', 'expired'].includes(row.status)) return false;
    if (row.expires_at > this.time()) return true;
    this.db.prepare("UPDATE agent_auth_registrations SET status='expired' WHERE id=? AND status NOT IN ('expired','revoked')").run(row.id);
    row.status = 'expired';
    this.audit(row.id, 'claim.expired', row.id, {});
    return false;
  }
  private limit(req: Request, action: string, maximum: number, duration: number) {
    const now = this.time();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_auth_rate_limits WHERE reset_at<=?').run(now);
      for (const [key, max] of [[hash(`${action}:ip:${req.ip ?? 'unknown'}`), maximum], [hash(`${action}:global`), maximum * 20]] as const) {
        const row = this.db.prepare('SELECT count FROM agent_auth_rate_limits WHERE key=?').get(key) as { count: number } | undefined;
        if (row && row.count >= max) throw new OAuthError('rate_limit_exceeded', 'Too many requests. Try again later.', 429);
        this.db.prepare('INSERT INTO agent_auth_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + duration);
      }
    }).immediate();
  }
  private audit(id: string, event: string, actor: string, data: unknown) {
    this.db.prepare('INSERT INTO audit_events(entity_type,entity_id,event_type,actor_id,data_json,created_at) VALUES(?,?,?,?,?,?)')
      .run('agent_registration', id, event, actor, JSON.stringify(data), iso(this.time()));
  }
  private startAttempt(row: Registration, req: Request) {
    const token = secret('cla'), code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = secret('attempt'), expiresAt = Math.min(row.expires_at, this.time() + CLAIM_TTL);
    this.db.prepare('DELETE FROM agent_auth_claim_attempts WHERE registration_id=?').run(row.id);
    this.db.prepare('INSERT INTO agent_auth_claim_attempts(id,registration_id,token_hash,code_hash,expires_at) VALUES(?,?,?,?,?)')
      .run(id, row.id, hash(token), hash(`${row.id}:${code}`), expiresAt);
    this.audit(row.id, 'claim.initiated', row.id, { claim_attempt_id: id, ip: req.ip });
    return { id, expiresAt, claim: { user_code: code, expires_in: Math.floor((expiresAt - this.time()) / 1000),
      verification_uri: `${this.issuer}/agent/claim?claim_attempt_token=${encodeURIComponent(token)}`, interval: POLL_INTERVAL } };
  }
  private humanClaim(req: Request, token: string) {
    const attempt = this.db.prepare('SELECT * FROM agent_auth_claim_attempts WHERE token_hash=?').get(hash(token)) as ClaimAttempt | undefined;
    const row = attempt ? this.get(attempt.registration_id) : undefined;
    const customer = req.legacyActor?.customer_id ? this.db.prepare('SELECT email FROM customers WHERE id=?').get(req.legacyActor.customer_id) as { email: string } | undefined : undefined;
    if (!attempt || !row || !this.active(row) || row.status !== 'unclaimed' || attempt.expires_at <= this.time() || attempt.failures >= 5
      || !customer || !row.claim_email || customer.email.trim().toLowerCase() !== row.claim_email) {
      throw new OAuthError('access_denied', 'Claim is unavailable or code is invalid.', 403);
    }
    return { row, attempt };
  }
  private assertion(row: Registration) {
    const now = Math.floor(this.time() / 1000), expires = Math.min(now + ASSERTION_TTL / 1000, Math.floor(row.expires_at / 1000));
    const header = Buffer.from(JSON.stringify({ typ: 'oauth-id-jag+jwt', alg: 'EdDSA', kid: this.keyId })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: this.issuer, sub: row.id, aud: `${this.issuer}/oauth2/token`, iat: now, exp: expires,
      jti: secret('jti'), version: row.version, ...(row.customer_id ? { email: row.claim_email, email_verified: true } : {}) })).toString('base64url');
    const encoded = `${header}.${payload}`;
    return { identity_assertion: `${encoded}.${sign(null, Buffer.from(encoded), this.key).toString('base64url')}`, assertion_expires: iso(expires * 1000) };
  }
  private exchange(assertion: string, req: Request) {
    const fail = (): never => { throw new OAuthError('invalid_grant', 'Invalid, expired or used identity assertion.'); };
    const parts = assertion.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return fail();
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    } catch { return fail(); }
    if (!header || !claims || header.alg !== 'EdDSA' || header.typ !== 'oauth-id-jag+jwt' || header.kid !== this.keyId) return fail();
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), this.publicKey, Buffer.from(parts[2]!, 'base64url'))) return fail();
    const now = Math.floor(this.time() / 1000);
    if (claims.iss !== this.issuer || claims.aud !== `${this.issuer}/oauth2/token` || typeof claims.sub !== 'string'
      || typeof claims.jti !== 'string' || claims.jti.length > 100 || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)
      || Number(claims.exp) <= now || Number(claims.iat) > now + 60 || Number(claims.exp) - Number(claims.iat) > ASSERTION_TTL / 1000
      || Number(claims.exp) <= Number(claims.iat)) return fail();
    const row = this.get(claims.sub);
    if (!row || !this.active(row) || claims.version !== row.version || (row.type === 'service_auth' && !row.customer_id)) return fail();
    this.db.prepare('DELETE FROM agent_auth_assertion_uses WHERE expires_at<=?').run(this.time());
    if (this.db.prepare('SELECT jti FROM agent_auth_assertion_uses WHERE jti=?').get(claims.jti)) return fail();
    this.db.prepare('INSERT INTO agent_auth_assertion_uses VALUES(?,?)').run(claims.jti, Number(claims.exp) * 1000 + 60_000);
    this.audit(row.id, 'credential.issued', row.id, { grant_type: JWT_GRANT, ip: req.ip });
    return { ...this.accessToken(row), ...this.assertion(row) };
  }
  private accessToken(row: Registration) {
    const token = secret('agt'), expires = Math.min(row.expires_at, this.time() + ACCESS_TTL);
    this.db.prepare('INSERT INTO agent_auth_access_tokens(token_hash,registration_id,version,expires_at) VALUES(?,?,?,?)').run(hash(token), row.id, row.version, expires);
    return { access_token: token, token_type: 'Bearer', expires_in: Math.floor((expires - this.time()) / 1000), scope: (row.customer_id ? SCOPES : PRE_SCOPES).join(' ') };
  }
  private poll(token: string, req: Request) {
    const row = this.byClaim(token), attempt = row ? this.attempt(row.id) : undefined;
    if (!row || !this.active(row) || !attempt || attempt.expires_at <= this.time() || row.claim_delivered || attempt.failures >= 5) {
      throw new OAuthError('expired_token', 'Claim is unavailable or expired.');
    }
    const now = this.time();
    if (attempt.last_poll_at !== null && now - attempt.last_poll_at < POLL_INTERVAL * 1000) throw new OAuthError('slow_down', 'Wait at least five seconds between polls.');
    this.db.prepare('UPDATE agent_auth_claim_attempts SET last_poll_at=? WHERE id=?').run(now, attempt.id);
    if (row.status !== 'claimed') throw new OAuthError('authorization_pending', 'Waiting for the human customer to confirm.');
    return this.db.transaction(() => {
      const consumed = this.db.prepare('UPDATE agent_auth_registrations SET claim_delivered=1 WHERE id=? AND claim_delivered=0').run(row.id);
      if (!consumed.changes) throw new OAuthError('expired_token', 'Claim has already been delivered.');
      this.audit(row.id, 'credential.issued', row.id, { grant_type: CLAIM_GRANT, ip: req.ip });
      return { ...this.accessToken(row), ...this.assertion(row) };
    }).immediate();
  }
  private authDocument() {
    return `# Pneu 007 agent authentication\n\nRegister an agent identity and ask a signed-in customer to authorize it.\n\nDiscovery: ${this.issuer}/.well-known/oauth-protected-resource\nAuthorization metadata: ${this.issuer}/.well-known/oauth-authorization-server\n\nPOST ${this.issuer}/agent/identity with JSON {"type":"anonymous"} for a stable unclaimed agent identity and a service-signed identity_assertion. Exchange it at ${this.issuer}/oauth2/token using form grant_type=${JWT_GRANT}&assertion=... . The assertion is single-use; retain the replacement identity_assertion returned by each exchange. Access tokens last at most one hour; replacement assertions last at most 24 hours and are capped by registration expiry. Unclaimed tokens can only inspect GET /api/agent/identity.\n\nTo bind the agent to a customer, POST ${this.issuer}/agent/identity/claim with JSON {"claim_token":"...","email":"customer@example.com"}. Or register with {"type":"service_auth","login_hint":"customer@example.com"}; this starts the ceremony immediately and issues no assertion before claim. Registration never proves the supplied email.\n\nShow the human the six-digit user_code and verification_uri. The human signs in to the matching customer account, reviews the requested scopes, and types the code. Never ask the human for their password, cookie, or CSRF token. Codes expire in ten minutes and lock after five wrong submissions. Poll ${this.issuer}/oauth2/token with form grant_type=${CLAIM_GRANT}&claim_token=... at the advertised five-second interval. On success, store the returned access_token and identity_assertion. Claim delivery is single-use. Pre-claim credentials are revoked at confirmation. Unclaimed registrations expire after 24 hours; claimed registrations expire after 30 days.\n\nScopes:\n- agent.identity: inspect the authenticated agent identity and its customer binding.\n- a2a: authenticate customer A2A requests after human claim.\n- customer.tools: use customer agent tools after human claim, subject to existing role and mandate checks.\n\nPOST ${this.issuer}/oauth2/revoke with form token=... to revoke one access token. Signed-in customers can review and revoke their registrations in the customer portal. Provider identity assertions and Security Event Tokens are not accepted. Agent registration grants no human approval or payment authority.\n\nTerms and privacy: ${this.issuer}/podminky.html\nIntegration contact: ${this.issuer}/kontakt.html\n`;
  }
}
