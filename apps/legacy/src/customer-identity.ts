import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { BusinessError } from '../../../packages/contracts/index.js';

export interface CustomerBusiness { business_id: string; resource_url: string; service_secret: string }
export interface CustomerHuman { id: string; email: string; name: string; phone: string }
export interface CustomerAccess {
  active: true; iss: string; sub: string; aud: string; client_id: string; exp: number; scope: string;
  business_id: string; connection_id: string; grant_id: string;
  profile: Partial<Pick<CustomerHuman, 'name' | 'email' | 'phone'>>; shared_fields: string[];
}
declare module 'express-serve-static-core' { interface Request { customerHuman?: CustomerHuman } }

interface Account extends CustomerHuman { salt: string; password_hash: string }
interface Session { token_hash: string; customer_id: string; csrf_hash: string; expires_at: number }
interface Connection {
  id: string; agent_name: string; customer_id: string | null; device_hash: string; code_hash: string;
  status: 'pending' | 'active' | 'revoked'; request_expires_at: number; expires_at: number;
  scopes: string; shared_fields: string; exchanged: number; failures: number;
}
interface Grant {
  id: string; customer_id: string; connection_id: string; business_id: string; resource_url: string;
  status: 'active' | 'revoked'; scopes: string; shared_fields: string;
}
interface ResourceToken { connection_id: string; grant_id: string; expires_at: number }
interface MandateDecision {
  token_hash: string; customer_id: string; business_id: string; connection_id: string; grant_id: string;
  mandate_id: string; mandate_hash: string; expires_at: number; consumed: number;
}
const SCOPES = ['a2a', 'customer.tools'];
const FIELDS = ['name', 'email', 'phone'];
const SESSION_TTL = 12 * 60 * 60_000;
const REQUEST_TTL = 10 * 60_000;
const CONSENT_TTL = 30 * 24 * 60 * 60_000;
const ACCESS_TTL = 600_000;
const COOKIE = 'handle_customer_session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function fail(message: string, status = 400, code = 'invalid_request'): never { throw new BusinessError(code, message, status); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid request fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail('Invalid text field.');
  return value.trim();
}
function email(value: unknown): string {
  const result = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('A valid email is required.');
  return result;
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) fail('Password must contain 12–200 characters.');
  return value;
}
function subset(value: unknown, allowed: string[], nonempty = false): string[] {
  if (!Array.isArray(value) || value.length > allowed.length || (nonempty && !value.length)
    || value.some(item => typeof item !== 'string' || !allowed.includes(item)) || new Set(value).size !== value.length) fail('Unsupported permissions or shared fields.');
  return allowed.filter(item => value.includes(item));
}
function origin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Customer identity requires HTTPS origins (HTTP is allowed only on loopback).');
  }
  return url.origin;
}
function bearer(req: Request): string {
  const token = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '')?.[1];
  if (!token || token.length > 200) fail('A bearer credential is required.', 401, 'invalid_token');
  return token;
}

/** Separate human customer identity and consent; never creates business-owner or legacy login authority. */
export class CustomerIdentity {
  private readonly now: () => Date;
  readonly issuer: string;
  private readonly businesses = new Map<string, { resource_url: string; service_hash: string }>();

  constructor(readonly db: Database.Database, options: { issuer: string; businesses: CustomerBusiness[]; now?: () => Date }) {
    this.issuer = origin(options.issuer);
    this.now = options.now ?? (() => new Date());
    const resources = new Set<string>(), serviceHashes = new Set<string>();
    for (const business of options.businesses) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(business.business_id) || this.businesses.has(business.business_id)
        || business.service_secret.length < 32 || business.service_secret.length > 200) throw new Error('Businesses need unique IDs and strong separate service credentials.');
      const resource = origin(business.resource_url), serviceHash = hash(business.service_secret);
      if (resources.has(resource) || serviceHashes.has(serviceHash)) throw new Error('Each business needs a separate service origin and credential.');
      resources.add(resource); serviceHashes.add(serviceHash);
      this.businesses.set(business.business_id, { resource_url: resource, service_hash: serviceHash });
    }
    if (!db.memory) {
      chmodSync(db.name, 0o600);
      for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(`${db.name}${suffix}`)) chmodSync(`${db.name}${suffix}`, 0o600);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS customer_identity_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_identity_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,phone TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_identity_sessions(token_hash TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customer_identity_accounts(id),csrf_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_identity_connections(id TEXT PRIMARY KEY,agent_name TEXT NOT NULL,customer_id TEXT REFERENCES customer_identity_accounts(id),device_hash TEXT NOT NULL UNIQUE,code_hash TEXT NOT NULL,status TEXT NOT NULL,request_expires_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,scopes TEXT NOT NULL,shared_fields TEXT NOT NULL,exchanged INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS customer_identity_delegations(token_hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL UNIQUE REFERENCES customer_identity_connections(id));
      CREATE TABLE IF NOT EXISTS customer_identity_subjects(customer_id TEXT NOT NULL REFERENCES customer_identity_accounts(id),business_id TEXT NOT NULL,subject TEXT NOT NULL UNIQUE,PRIMARY KEY(customer_id,business_id));
      CREATE TABLE IF NOT EXISTS customer_identity_grants(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customer_identity_accounts(id),connection_id TEXT NOT NULL REFERENCES customer_identity_connections(id),business_id TEXT NOT NULL,resource_url TEXT NOT NULL,status TEXT NOT NULL,scopes TEXT NOT NULL,shared_fields TEXT NOT NULL,UNIQUE(connection_id,business_id));
      CREATE TABLE IF NOT EXISTS customer_identity_tokens(token_hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES customer_identity_connections(id),grant_id TEXT NOT NULL REFERENCES customer_identity_grants(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_identity_mandate_decisions(token_hash TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customer_identity_accounts(id),business_id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES customer_identity_connections(id),grant_id TEXT NOT NULL REFERENCES customer_identity_grants(id),mandate_id TEXT NOT NULL,mandate_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS customer_identity_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS customer_identity_immutable_binding BEFORE UPDATE OF customer_id ON customer_identity_connections
        WHEN OLD.customer_id IS NOT NULL AND (NEW.customer_id IS NULL OR NEW.customer_id!=OLD.customer_id)
        BEGIN SELECT RAISE(ABORT,'Customer connection binding is immutable'); END;`);
    db.prepare('INSERT OR IGNORE INTO customer_identity_settings VALUES(?,?)').run('issuer', this.issuer);
    const configured = db.prepare('SELECT value FROM customer_identity_settings WHERE key=?').get('issuer') as { value: string };
    if (configured.value !== this.issuer) throw new Error('A customer identity database belongs to one persistent issuer.');
  }

  /** Use on Handle human proxy endpoints. Cookie alone never authorizes a write. */
  human: RequestHandler = (req, res, next) => {
    try {
      if (req.header('authorization')) fail('A human Handle customer session is required.', 403, 'access_denied');
      const session = this.session(req);
      if (!session) fail('Sign into Handle as a customer.', 401, 'unauthenticated');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        this.checkOrigin(req);
        const csrf = req.header('x-csrf-token') ?? '';
        if (csrf.length > 200 || !same(hash(csrf), session.csrf_hash)) fail('Invalid session CSRF token.', 403, 'access_denied');
      }
      req.customerHuman = this.account(session.customer_id);
      next();
    } catch (error) { this.error(error, res, next); }
  };

  introspect(token: string, serviceSecret: string): CustomerAccess | { active: false } {
    if (typeof token !== 'string' || token.length > 200 || !token.startsWith('hca_')
      || typeof serviceSecret !== 'string' || serviceSecret.length > 200) return { active: false };
    const serviceHash = hash(serviceSecret);
    const businessId = [...this.businesses].find(([, business]) => same(business.service_hash, serviceHash))?.[0];
    if (!businessId) return { active: false };
    const row = this.db.prepare('SELECT connection_id,grant_id,expires_at FROM customer_identity_tokens WHERE token_hash=? AND expires_at>?')
      .get(hash(token), this.time()) as ResourceToken | undefined;
    if (!row) return { active: false };
    const grant = this.db.prepare('SELECT * FROM customer_identity_grants WHERE id=? AND business_id=?').get(row.grant_id, businessId) as Grant | undefined;
    const connection = this.connection(row.connection_id);
    if (!grant || !connection || !this.active(connection, grant)) return { active: false };
    return this.access(connection, grant, row.expires_at);
  }

  business(id: string): { business_id: string; resource_url: string } | undefined {
    const business = this.businesses.get(id);
    return business ? { business_id: id, resource_url: business.resource_url } : undefined;
  }

  /** Business-authenticated live validation for a human decision forwarded by Handle. */
  grantContext(serviceSecret: string, connectionId: string, grantId: string): CustomerAccess | { active: false } {
    if (typeof serviceSecret !== 'string' || serviceSecret.length > 200 || typeof connectionId !== 'string' || typeof grantId !== 'string') return { active: false };
    const businessId = [...this.businesses].find(([, business]) => same(business.service_hash, hash(serviceSecret)))?.[0];
    if (!businessId) return { active: false };
    const grant = this.db.prepare('SELECT * FROM customer_identity_grants WHERE id=? AND business_id=? AND connection_id=?').get(grantId, businessId, connectionId) as Grant | undefined;
    const connection = this.connection(connectionId);
    if (!grant || !connection || !this.active(connection, grant)) return { active: false };
    return this.access(connection, grant, Math.min(this.time() + ACCESS_TTL, connection.expires_at));
  }

  /** Central-only mint: call only after a CSRF-protected human decision on the exact mandate. */
  createMandateDecision(customerId: string, businessId: string, connectionId: string, mandateId: string, mandateHash: string): string {
    if (typeof mandateId !== 'string' || !mandateId || mandateId.length > 200
      || typeof mandateHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(mandateHash)) fail('Invalid mandate decision binding.');
    return this.db.transaction(() => {
      const access = this.accessForCustomer(customerId, businessId, connectionId), ticket = secret('hcm');
      const connection = this.connection(connectionId)!;
      this.db.prepare('DELETE FROM customer_identity_mandate_decisions WHERE expires_at<=?').run(this.time());
      this.db.prepare('INSERT INTO customer_identity_mandate_decisions VALUES(?,?,?,?,?,?,?,?,0)')
        .run(hash(ticket), customerId, businessId, connectionId, access.grant_id, mandateId, mandateHash,
          Math.min(this.time() + 120_000, connection.expires_at));
      return ticket;
    }).immediate();
  }

  /** A service can consume a human decision, but its own credential can never mint one. */
  consumeMandateDecision(serviceSecret: string, ticket: string, mandateId: string, mandateHash: string): CustomerAccess | { active: false } {
    if (typeof serviceSecret !== 'string' || serviceSecret.length > 200 || typeof ticket !== 'string'
      || !ticket.startsWith('hcm_') || ticket.length > 200 || typeof mandateId !== 'string' || typeof mandateHash !== 'string') return { active: false };
    const businessId = [...this.businesses].find(([, business]) => same(business.service_hash, hash(serviceSecret)))?.[0];
    if (!businessId) return { active: false };
    return this.db.transaction((): CustomerAccess | { active: false } => {
      const decision = this.db.prepare('SELECT * FROM customer_identity_mandate_decisions WHERE token_hash=? AND consumed=0 AND expires_at>?')
        .get(hash(ticket), this.time()) as MandateDecision | undefined;
      if (!decision || decision.business_id !== businessId || decision.mandate_id !== mandateId || !same(decision.mandate_hash, mandateHash)) return { active: false };
      const grant = this.db.prepare('SELECT * FROM customer_identity_grants WHERE id=? AND business_id=? AND customer_id=? AND connection_id=?')
        .get(decision.grant_id, businessId, decision.customer_id, decision.connection_id) as Grant | undefined;
      const connection = this.connection(decision.connection_id);
      if (!grant || !connection || !this.active(connection, grant)) return { active: false };
      const consumed = this.db.prepare('UPDATE customer_identity_mandate_decisions SET consumed=1 WHERE token_hash=? AND consumed=0').run(decision.token_hash);
      if (!consumed.changes) return { active: false };
      return this.access(connection, grant, Math.min(this.time() + ACCESS_TTL, connection.expires_at));
    }).immediate();
  }

  /** Resolves an owned existing grant for a separately authenticated Handle human decision. */
  accessForCustomer(customerId: string, businessId: string, connectionId: string): CustomerAccess {
    const connection = this.connection(connectionId);
    const grant = this.db.prepare('SELECT * FROM customer_identity_grants WHERE connection_id=? AND business_id=? AND customer_id=?')
      .get(connectionId, businessId, customerId) as Grant | undefined;
    if (!connection || connection.customer_id !== customerId || !grant || !this.active(connection, grant)) fail('No active customer grant for this business.', 403, 'access_denied');
    return this.access(connection, grant, Math.min(this.time() + ACCESS_TTL, connection.expires_at));
  }

  router(): express.Router {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }));
    const route = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
      try { fn(req, res); } catch (error) { this.error(error, res, next); }
    };
    router.post('/signup', route((req, res) => {
      this.checkOrigin(req); this.limit(req, 'signup', 20, 60 * 60_000);
      const input = object(req.body, ['email', 'password', 'name', 'phone']);
      const address = email(input.email), pass = password(input.password);
      const name = input.name === undefined ? '' : text(input.name, 200, true), phone = input.phone === undefined ? '' : text(input.phone, 50, true);
      const salt = randomBytes(16).toString('hex'), id = secret('hcu');
      const passwordHash = scryptSync(pass, salt, 64).toString('hex');
      if (this.db.prepare('SELECT 1 FROM customer_identity_accounts WHERE email=?').get(address)) fail('Unable to create account with these details.', 409, 'account_unavailable');
      this.db.prepare('INSERT INTO customer_identity_accounts VALUES(?,?,?,?,?,?)').run(id, address, name, phone, salt, passwordHash);
      res.status(201).json(this.startSession(id, req, res));
    }));
    router.post('/login', route((req, res) => {
      this.checkOrigin(req); this.limit(req, 'login', 30, 15 * 60_000);
      const input = object(req.body, ['email', 'password']), address = email(input.email), pass = password(input.password);
      this.limit(req, `login:${hash(address)}`, 10, 15 * 60_000);
      const account = this.db.prepare('SELECT * FROM customer_identity_accounts WHERE email=?').get(address) as Account | undefined;
      const calculated = scryptSync(pass, account?.salt ?? 'missing-customer-timing-salt', 64).toString('hex');
      if (!account || !same(calculated, account.password_hash)) fail('Invalid email or password.', 401, 'invalid_login');
      res.json(this.startSession(account.id, req, res));
    }));
    router.get('/session', route((req, res) => {
      if (req.header('authorization')) fail('A human Handle customer session is required.', 403, 'access_denied');
      const session = this.session(req);
      if (!session) { res.json({ customer: null }); return; }
      const csrf = this.csrf(this.cookieToken(req)!);
      res.json({ customer: this.account(session.customer_id), csrf_token: csrf });
    }));
    router.post('/logout', this.human, route((req, res) => {
      object(req.body, []);
      this.db.prepare('DELETE FROM customer_identity_sessions WHERE token_hash=?').run(this.session(req)!.token_hash);
      res.clearCookie(COOKIE, { path: '/api/handle/customer', httpOnly: true, sameSite: 'strict', secure: this.issuer.startsWith('https:') });
      res.json({ ok: true });
    }));
    router.post('/profile', this.human, route((req, res) => {
      const input = object(req.body, ['email', 'name', 'phone']), customer = req.customerHuman!;
      const address = input.email === undefined ? customer.email : email(input.email);
      const name = input.name === undefined ? customer.name : text(input.name, 200, true), phone = input.phone === undefined ? customer.phone : text(input.phone, 50, true);
      if (this.db.prepare('SELECT 1 FROM customer_identity_accounts WHERE email=? AND id!=?').get(address, customer.id)) fail('Unable to use these profile details.', 409, 'account_unavailable');
      this.db.prepare('UPDATE customer_identity_accounts SET email=?,name=?,phone=? WHERE id=?').run(address, name, phone, customer.id);
      res.json({ customer: this.account(customer.id) });
    }));
    router.post('/connections/register', route((req, res) => {
      this.limit(req, 'register', 20, 60 * 60_000);
      const input = object(req.body, ['name']), name = text(input.name);
      const id = secret('hcc'), deviceCode = secret('hcdv'), code = randomInt(0, 1_000_000).toString().padStart(6, '0'), now = this.time();
      this.db.prepare(`INSERT INTO customer_identity_connections(id,agent_name,device_hash,code_hash,status,request_expires_at,expires_at,scopes,shared_fields) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, name, hash(deviceCode), hash(code), 'pending', now + REQUEST_TTL, now + REQUEST_TTL, JSON.stringify(SCOPES), JSON.stringify(FIELDS));
      res.status(201).json({ connection_id: id, device_code: deviceCode, user_code: code, verification_uri: `${this.issuer}/handle/customer?connection=${id}`, expires_in: REQUEST_TTL / 1000 });
    }));
    router.get('/connections/:id', this.human, route((req, res) => {
      const connection = this.connection(String(req.params.id));
      if (!connection || (connection.customer_id && connection.customer_id !== req.customerHuman!.id)) fail('Connection not found.', 404, 'not_found');
      res.json({ connection: this.connectionView(connection) });
    }));
    router.post('/connections/:id/approve', this.human, route((req, res) => {
      this.limit(req, 'approve', 40, 15 * 60_000);
      const input = object(req.body, ['user_code', 'scopes', 'shared_fields']);
      const code = text(input.user_code, 6), scopes = subset(input.scopes, SCOPES, true), fields = subset(input.shared_fields, FIELDS);
      const connection = this.connection(String(req.params.id));
      if (!connection || connection.status !== 'pending' || connection.customer_id || connection.request_expires_at <= this.time() || connection.failures >= 5) fail('Connection consent is unavailable or expired.', 403, 'access_denied');
      if (!same(hash(code), connection.code_hash)) {
        this.db.prepare('UPDATE customer_identity_connections SET failures=failures+1 WHERE id=?').run(connection.id);
        fail('Invalid verification code.', 403, 'access_denied');
      }
      const updated = this.db.prepare(`UPDATE customer_identity_connections SET customer_id=?,status='active',expires_at=?,scopes=?,shared_fields=? WHERE id=? AND status='pending' AND customer_id IS NULL`)
        .run(req.customerHuman!.id, this.time() + CONSENT_TTL, JSON.stringify(scopes), JSON.stringify(fields), connection.id);
      if (!updated.changes) fail('Consent was already used.', 403, 'access_denied');
      res.json({ connection: this.connectionView(this.connection(connection.id)!) });
    }));
    router.post('/connections/exchange', route((req, res) => {
      this.limit(req, 'exchange', 120, 60_000);
      const input = object(req.body, ['device_code']), deviceCode = text(input.device_code);
      const connection = this.db.prepare('SELECT * FROM customer_identity_connections WHERE device_hash=?').get(hash(deviceCode)) as Connection | undefined;
      if (!connection || connection.request_expires_at <= this.time() || connection.failures >= 5 || connection.status === 'revoked' || connection.exchanged) fail('Device credential expired or already used.', 400, 'expired_token');
      if (connection.status !== 'active' || !connection.customer_id) fail('Human consent is pending.', 400, 'authorization_pending');
      const token = secret('hcd');
      this.db.transaction(() => {
        const changed = this.db.prepare('UPDATE customer_identity_connections SET exchanged=1 WHERE id=? AND exchanged=0').run(connection.id);
        if (!changed.changes) fail('Device credential already used.', 400, 'expired_token');
        this.db.prepare('INSERT INTO customer_identity_delegations VALUES(?,?)').run(hash(token), connection.id);
      }).immediate();
      res.json({ delegation_token: token, token_type: 'Bearer', expires_in: Math.floor((connection.expires_at - this.time()) / 1000), connection_id: connection.id, scope: JSON.parse(connection.scopes).join(' ') });
    }));
    router.post('/token', route((req, res) => {
      this.limit(req, 'token', 120, 60_000);
      const input = object(req.body, ['business_id']), businessId = text(input.business_id), business = this.businesses.get(businessId);
      if (!business) fail('Business is not registered with this issuer.', 400, 'invalid_target');
      const delegation = bearer(req);
      if (!delegation.startsWith('hcd_')) fail('Invalid delegation credential.', 401, 'invalid_token');
      const connection = this.db.prepare(`SELECT c.* FROM customer_identity_connections c JOIN customer_identity_delegations d ON d.connection_id=c.id WHERE d.token_hash=?`).get(hash(delegation)) as Connection | undefined;
      if (!connection || !connection.customer_id || connection.status !== 'active' || connection.expires_at <= this.time()) fail('Customer delegation is not active.', 401, 'invalid_token');
      const token = secret('hca'), expiresAt = Math.min(this.time() + ACCESS_TTL, connection.expires_at);
      const grant = this.db.transaction(() => {
        this.db.prepare(`INSERT OR IGNORE INTO customer_identity_grants VALUES(?,?,?,?,?,'active',?,?)`)
          .run(secret('hcg'), connection.customer_id, connection.id, businessId, business.resource_url, connection.scopes, connection.shared_fields);
        const grant = this.db.prepare('SELECT * FROM customer_identity_grants WHERE connection_id=? AND business_id=?').get(connection.id, businessId) as Grant;
        if (!this.active(connection, grant)) fail('Business grant is revoked or no longer valid.', 403, 'access_denied');
        this.subject(connection.customer_id!, businessId);
        this.db.prepare('DELETE FROM customer_identity_tokens WHERE expires_at<=?').run(this.time());
        this.db.prepare('INSERT INTO customer_identity_tokens VALUES(?,?,?,?)').run(hash(token), connection.id, grant.id, expiresAt);
        return grant;
      }).immediate();
      res.json({ access_token: token, token_type: 'Bearer', expires_in: Math.floor((expiresAt - this.time()) / 1000), business_id: businessId, resource_url: business.resource_url, scope: JSON.parse(grant.scopes).join(' ') });
    }));
    router.get('/access', this.human, route((req, res) => {
      const connections = this.db.prepare('SELECT * FROM customer_identity_connections WHERE customer_id=? ORDER BY rowid').all(req.customerHuman!.id) as Connection[];
      const grants = this.db.prepare('SELECT * FROM customer_identity_grants WHERE customer_id=? ORDER BY rowid').all(req.customerHuman!.id) as Grant[];
      res.json({ connections: connections.map(connection => this.connectionView(connection)), grants: grants.map(grant => {
        const connection = connections.find(candidate => candidate.id === grant.connection_id);
        const status = grant.status === 'revoked' || connection?.status === 'revoked' ? 'revoked'
          : !connection || connection.expires_at <= this.time() ? 'expired' : 'active';
        return { id: grant.id, business_id: grant.business_id, resource_url: grant.resource_url, status,
          scopes: JSON.parse(grant.scopes), shared_fields: JSON.parse(grant.shared_fields), connection_id: grant.connection_id };
      }) });
    }));
    router.post('/connections/:id/revoke', this.human, route((req, res) => {
      object(req.body, []);
      if (!this.db.prepare(`UPDATE customer_identity_connections SET status='revoked' WHERE id=? AND customer_id=?`).run(String(req.params.id), req.customerHuman!.id).changes) fail('Connection not found.', 404, 'not_found');
      res.json({ ok: true });
    }));
    router.post('/grants/:id/revoke', this.human, route((req, res) => {
      object(req.body, []);
      if (!this.db.prepare(`UPDATE customer_identity_grants SET status='revoked' WHERE id=? AND customer_id=?`).run(String(req.params.id), req.customerHuman!.id).changes) fail('Grant not found.', 404, 'not_found');
      res.json({ ok: true });
    }));
    router.post('/mandate-decisions/consume', route((req, res) => {
      const credential = bearer(req);
      if (![...this.businesses.values()].some(business => same(hash(credential), business.service_hash))) fail('Registered business authentication is required.', 401, 'invalid_client');
      this.limit(req, `mandate-decisions:${hash(credential)}`, 2000, 60_000);
      const input = object(req.body, ['ticket', 'mandate_id', 'mandate_hash']);
      res.json(this.consumeMandateDecision(credential, text(input.ticket), text(input.mandate_id), text(input.mandate_hash)));
    }));
    router.post('/grant-context', route((req, res) => {
      const credential = bearer(req);
      if (![...this.businesses.values()].some(business => same(hash(credential), business.service_hash))) fail('Registered business authentication is required.', 401, 'invalid_client');
      this.limit(req, `grant-context:${hash(credential)}`, 2000, 60_000);
      const input = object(req.body, ['connection_id', 'grant_id']);
      res.json(this.grantContext(credential, text(input.connection_id), text(input.grant_id)));
    }));
    router.post('/introspect', route((req, res) => {
      const credential = bearer(req);
      if (![...this.businesses.values()].some(business => same(hash(credential), business.service_hash))) fail('Registered business authentication is required.', 401, 'invalid_client');
      this.limit(req, `introspect:${hash(credential)}`, 2000, 60_000);
      const input = object(req.body, ['token']);
      res.json(this.introspect(text(input.token), credential));
    }));
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (error && typeof error === 'object' && 'status' in error && (error.status === 400 || error.status === 413)) {
        res.status(error.status).json({ error: 'invalid_request', error_description: 'Invalid or oversized request body.' });
      } else this.error(error, res, next);
    });
    return router;
  }

  private time() { return this.now().getTime(); }
  private account(id: string): CustomerHuman {
    const account = this.db.prepare('SELECT id,email,name,phone FROM customer_identity_accounts WHERE id=?').get(id) as CustomerHuman | undefined;
    if (!account) fail('Customer account unavailable.', 401, 'unauthenticated');
    return account;
  }
  private connection(id: string) { return this.db.prepare('SELECT * FROM customer_identity_connections WHERE id=?').get(id) as Connection | undefined; }
  private cookieToken(req: Request): string | undefined {
    const token = req.header('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return token && token.length <= 200 ? token : undefined;
  }
  private csrf(sessionToken: string): string { return `csrf_${hash(`handle-customer-csrf:${sessionToken}`)}`; }
  private session(req: Request): Session | undefined {
    const token = this.cookieToken(req);
    if (!token) return;
    return this.db.prepare('SELECT * FROM customer_identity_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), this.time()) as Session | undefined;
  }
  private startSession(customerId: string, req: Request, res: Response) {
    const old = this.session(req);
    if (old) this.db.prepare('DELETE FROM customer_identity_sessions WHERE token_hash=?').run(old.token_hash);
    const token = secret('hcs'), csrf = this.csrf(token);
    this.db.prepare('DELETE FROM customer_identity_sessions WHERE expires_at<=?').run(this.time());
    this.db.prepare('INSERT INTO customer_identity_sessions VALUES(?,?,?,?)').run(hash(token), customerId, hash(csrf), this.time() + SESSION_TTL);
    res.cookie(COOKIE, token, { httpOnly: true, secure: this.issuer.startsWith('https:'), sameSite: 'strict', path: '/api/handle/customer', maxAge: SESSION_TTL });
    return { customer: this.account(customerId), csrf_token: csrf };
  }
  private checkOrigin(req: Request) {
    if ((req.header('origin') && req.header('origin') !== this.issuer) || req.header('sec-fetch-site') === 'cross-site') fail('Foreign origin is not permitted.', 403, 'access_denied');
  }
  private active(connection: Connection, grant: Grant): boolean {
    const business = this.businesses.get(grant.business_id);
    return connection.status === 'active' && connection.expires_at > this.time() && !!connection.customer_id
      && grant.status === 'active' && grant.customer_id === connection.customer_id && grant.connection_id === connection.id
      && !!business && business.resource_url === grant.resource_url
      && (JSON.parse(grant.scopes) as string[]).every(scope => SCOPES.includes(scope) && (JSON.parse(connection.scopes) as string[]).includes(scope))
      && (JSON.parse(grant.shared_fields) as string[]).every(field => FIELDS.includes(field) && (JSON.parse(connection.shared_fields) as string[]).includes(field));
  }
  private subject(customerId: string, businessId: string): string {
    this.db.prepare('INSERT OR IGNORE INTO customer_identity_subjects VALUES(?,?,?)').run(customerId, businessId, secret('hcsub'));
    return (this.db.prepare('SELECT subject FROM customer_identity_subjects WHERE customer_id=? AND business_id=?').get(customerId, businessId) as { subject: string }).subject;
  }
  private access(connection: Connection, grant: Grant, expiresAt: number): CustomerAccess {
    const customer = this.account(connection.customer_id!), shared = JSON.parse(grant.shared_fields) as ('name' | 'email' | 'phone')[];
    const profile: CustomerAccess['profile'] = {};
    for (const field of shared) profile[field] = customer[field];
    return { active: true, iss: this.issuer, sub: this.subject(customer.id, grant.business_id), aud: grant.resource_url,
      client_id: connection.id, exp: Math.floor(expiresAt / 1000), scope: (JSON.parse(grant.scopes) as string[]).join(' '),
      business_id: grant.business_id, connection_id: connection.id, grant_id: grant.id, profile, shared_fields: shared };
  }
  private connectionView(connection: Connection) {
    return { id: connection.id, agent_name: connection.agent_name, status: connection.expires_at <= this.time() ? 'expired' : connection.status,
      expires_at: new Date(connection.expires_at).toISOString(), scopes: JSON.parse(connection.scopes), shared_fields: JSON.parse(connection.shared_fields) };
  }
  private limit(req: Request, action: string, max: number, duration: number) {
    const now = this.time();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM customer_identity_limits WHERE reset_at<=?').run(now);
      // Bound the number of attacker-chosen IP/action rows before expensive password work.
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM customer_identity_limits').get() as { n: number };
      if (count.n >= 4096) fail('Too many requests. Try again later.', 429, 'rate_limited');
      const key = hash(`${req.ip ?? 'unknown'}:${action}`);
      this.db.prepare('INSERT INTO customer_identity_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + duration);
    }).immediate();
    const bucket = this.db.prepare('SELECT count FROM customer_identity_limits WHERE key=?').get(hash(`${req.ip ?? 'unknown'}:${action}`)) as { count: number };
    if (bucket.count > max) fail('Too many requests. Try again later.', 429, 'rate_limited');
  }
  private error(error: unknown, res: Response, next: NextFunction) {
    if (error instanceof BusinessError) {
      res.set('Cache-Control', 'no-store');
      if (error.status === 429) res.set('Retry-After', '60');
      res.status(error.status).json({ error: error.code, error_description: error.message });
    } else next(error);
  }
}
