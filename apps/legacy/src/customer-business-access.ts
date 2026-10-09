import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RequestHandler } from 'express';
import { BusinessError, type Actor } from '../../../packages/contracts/index.js';
import type { CustomerAccess, CustomerIdentity } from './customer-identity.js';

function denied(message = 'Customer access is unavailable.', status = 401): never {
  throw new BusinessError('CUSTOMER_ACCESS_DENIED', message, status);
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
export function customerOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Customer identity requires HTTPS origins (loopback HTTP is allowed for local tests).');
  }
  return url.origin;
}

interface BusinessAccessOptions {
  issuer: string;
  business_id: string;
  resource_url: string;
  service_secret: string;
  nativeBusinessId: () => string;
  now?: () => Date;
  request?: typeof fetch;
  localIssuer?: CustomerIdentity;
}
interface VerifiedCustomer { token: string; actor: Actor; access: CustomerAccess }

/** The request-local lookup preserves existing synchronous auth APIs without caching authority across requests. */
export class CustomerBusinessAccess {
  readonly issuer: string;
  readonly resource: string;
  private readonly context = new AsyncLocalStorage<VerifiedCustomer>();
  private readonly now: () => Date;
  constructor(readonly db: Database.Database, readonly options: BusinessAccessOptions) {
    this.issuer = customerOrigin(options.issuer);
    this.resource = customerOrigin(options.resource_url);
    if (!identifier(options.business_id) || options.service_secret.length < 32) throw new Error('Configure a business ID and a separate customer-identity service secret of at least 32 characters.');
    this.now = options.now ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS customer_identity_mappings(
      business_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES customers(id),
      PRIMARY KEY(business_id,issuer,subject));`);
  }

  private validate(value: unknown): CustomerAccess {
    if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
    const v = value as CustomerAccess;
    const now = this.now().getTime() / 1000;
    if (v.active !== true || v.iss !== this.issuer || v.aud !== this.resource || v.business_id !== this.options.business_id ||
      !identifier(v.sub) || !identifier(v.client_id) || !identifier(v.connection_id) || !identifier(v.grant_id) ||
      !Number.isSafeInteger(v.exp) || v.exp <= now || v.exp > now + 600 || typeof v.scope !== 'string') denied();
    const scopes = v.scope.split(' ');
    if (!scopes.length || scopes.some(scope => !['a2a', 'customer.tools'].includes(scope)) || new Set(scopes).size !== scopes.length) denied();
    if (!Array.isArray(v.shared_fields) || v.shared_fields.some(field => !['name', 'email', 'phone'].includes(field)) ||
      !v.profile || typeof v.profile !== 'object' || Array.isArray(v.profile) ||
      Object.entries(v.profile).some(([field, value]) => !v.shared_fields.includes(field) || typeof value !== 'string' || value.length > 254)) denied();
    return v;
  }

  private async issuerRequest(path: '/introspect' | '/grant-context' | '/mandate-decisions/consume', body: Record<string, string>): Promise<CustomerAccess> {
    try {
      if (this.options.localIssuer) {
        const value = path === '/introspect' ? this.options.localIssuer.introspect(body.token!, this.options.service_secret)
          : path === '/grant-context' ? this.options.localIssuer.grantContext(this.options.service_secret, body.connection_id!, body.grant_id!)
          : this.options.localIssuer.consumeMandateDecision(this.options.service_secret, body.ticket!, body.mandate_id!, body.mandate_hash!);
        return this.validate(value);
      }
      const response = await (this.options.request ?? fetch)(`${this.issuer}/api/handle/customer/v1${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${this.options.service_secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) denied();
      return this.validate(await response.json());
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      denied('Customer identity verification is unavailable.', 503);
    }
  }

  /** Contacts are purpose-filtered by the issuer; identifiers never come from email or request payloads. */
  private actor(access: CustomerAccess): Actor {
    const businessId = this.options.nativeBusinessId();
    const customerId = this.db.transaction(() => {
      const old = this.db.prepare('SELECT customer_id FROM customer_identity_mappings WHERE business_id=? AND issuer=? AND subject=?')
        .get(businessId, access.iss, access.sub) as { customer_id: string } | undefined;
      const id = old?.customer_id ?? `handle-customer-${randomUUID()}`;
      const profile = access.profile as Record<string, string>;
      if (!old) {
        this.db.prepare('INSERT INTO customers(id,name,email,phone,origin) VALUES(?,?,?,?,?)')
          .run(id, profile.name ?? '', profile.email ?? '', profile.phone ?? '', 'handle_customer');
        this.db.prepare('INSERT INTO customer_identity_mappings VALUES(?,?,?,?)').run(businessId, access.iss, access.sub, id);
      } else {
        this.db.prepare('UPDATE customers SET name=?,email=?,phone=? WHERE id=?').run(profile.name ?? '', profile.email ?? '', profile.phone ?? '', id);
      }
      return id;
    }).immediate();
    return { id: access.client_id, role: 'customer_agent', customer_id: customerId, business_id: businessId,
      connection_id: access.connection_id, scopes: access.scope.split(' ') };
  }

  async authenticate(token: string): Promise<VerifiedCustomer> {
    if (!/^hca_[A-Za-z0-9_-]{1,200}$/.test(token)) denied();
    const access = await this.issuerRequest('/introspect', { token });
    return { token, access, actor: this.actor(access) };
  }

  identify(token: string): Actor | undefined {
    const current = this.context.getStore();
    return current?.token === token && current.access.exp > this.now().getTime() / 1000 ? current.actor : undefined;
  }

  readonly middleware: RequestHandler = async (req, _res, next) => {
    const token = /^Bearer\s+(hca_[^\s]+)$/i.exec(req.header('authorization') ?? '')?.[1];
    if (!token) return next();
    try {
      const current = await this.authenticate(token);
      const scope = /^\/(?:a2a(?:\/|$)|relay\/[^/]+\/a2a(?:\/|$))/i.test(req.path) ? 'a2a' : 'customer.tools';
      if (!current.actor.scopes!.includes(scope)) denied('The credential does not permit this operation.', 403);
      this.context.run(current, next);
    } catch (error) { next(error); }
  };

  async humanGrant(authorization: string | undefined, context: unknown): Promise<{ access: CustomerAccess; actor: Actor }> {
    const supplied = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
    const left = Buffer.from(supplied), right = Buffer.from(this.options.service_secret);
    if (left.length !== right.length || !timingSafeEqual(left, right)) denied('Business service authentication required.', 403);
    if (!context || typeof context !== 'object' || Array.isArray(context)) denied();
    const c = context as Record<string, unknown>;
    if (!identifier(c.connection_id) || !identifier(c.grant_id) || !identifier(c.sub)) denied();
    const access = await this.issuerRequest('/grant-context', { connection_id: c.connection_id, grant_id: c.grant_id });
    if (access.sub !== c.sub || access.connection_id !== c.connection_id || access.grant_id !== c.grant_id || !access.scope.split(' ').includes('customer.tools')) denied();
    return { access, actor: this.actor(access) };
  }

  async consumeHumanDecision(ticket: unknown, mandateId: string, mandateHash: unknown, expected: CustomerAccess): Promise<void> {
    if (typeof ticket !== 'string' || !/^hcm_[A-Za-z0-9_-]{1,200}$/.test(ticket) || typeof mandateHash !== 'string' || !/^[a-f0-9]{64}$/.test(mandateHash)) denied('An exact human Handle decision is required.', 403);
    const access = await this.issuerRequest('/mandate-decisions/consume', { ticket, mandate_id: mandateId, mandate_hash: mandateHash });
    if (access.sub !== expected.sub || access.grant_id !== expected.grant_id || access.connection_id !== expected.connection_id || access.client_id !== expected.client_id) denied('Human decision belongs to another delegation.', 403);
  }
}
