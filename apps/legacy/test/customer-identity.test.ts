import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { CustomerIdentity, type CustomerAccess, type CustomerBusiness } from '../src/customer-identity.js';

const issuer = 'https://handle.example';
const businesses: CustomerBusiness[] = [
  { business_id: 'pneu-a', resource_url: 'https://garage-a.example', service_secret: 'business-a-service-secret-0123456789' },
  { business_id: 'pneu-b', resource_url: 'https://garage-b.example', service_secret: 'business-b-service-secret-0123456789' },
];
const password = 'customer-human-password-0123456789';
const prefix = '/api/handle/customer/v1';
type Human = { headers: Record<string, string>; id: string; csrf: string; cookie: string };
type Registration = { connection_id: string; device_code: string; user_code: string; verification_uri: string; expires_in: number };

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'customer-identity-'));
  const filename = join(dir, 'identity.sqlite'), db = new Database(filename);
  let clock = Date.parse('2026-10-09T08:00:00Z');
  const now = () => new Date(clock), identity = new CustomerIdentity(db, { issuer, businesses, now });
  const app = express();
  app.use(prefix, identity.router());
  app.post('/api/handle/customer/decision', identity.human, (req, res) => res.json({ human: req.customerHuman }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${prefix}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
  });
  const human = async (address = 'customer@example.com'): Promise<Human> => {
    const response = await call('/signup', { email: address, password, name: 'Jana', phone: '+420123456789' });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { id: result.customer.id, csrf: result.csrf_token, cookie, headers: { cookie, 'x-csrf-token': result.csrf_token } };
  };
  const register = async (): Promise<Registration> => {
    const response = await call('/connections/register', { name: 'Personal agent' });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const approve = (registration: Registration, customer: Human, scopes = ['a2a', 'customer.tools'], shared_fields = ['name', 'email']) =>
    call(`/connections/${registration.connection_id}/approve`, { user_code: registration.user_code, scopes, shared_fields }, customer.headers);
  const connect = async (customer: Human, fields = ['name', 'email'], scopes = ['a2a', 'customer.tools']) => {
    const registration = await register();
    assert.equal((await approve(registration, customer, scopes, fields)).status, 200);
    const exchange = await call('/connections/exchange', { device_code: registration.device_code });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const delegation = (await exchange.json()).delegation_token as string;
    return { ...registration, delegation };
  };
  const token = async (delegation: string, business_id = 'pneu-a') => {
    const response = await call('/token', { business_id }, { authorization: `Bearer ${delegation}` });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { access_token: string; expires_in: number; scope: string; business_id: string; resource_url: string };
  };
  return { db, filename, identity, call, base, human, register, approve, connect, token, now, advance: (ms: number) => { clock += ms; } };
}

test('customer issuer and businesses require pinned distinct secure origins and credentials', () => {
  const db = new Database(':memory:');
  try {
    for (const bad of ['http://handle.example', 'https://user:pass@handle.example', 'https://handle.example/path', 'https://handle.example?q=x', 'ftp://handle.example', 'https://handle.example/#x']) {
      assert.throws(() => new CustomerIdentity(db, { issuer: bad, businesses }), /HTTPS origins/);
    }
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses: [{ ...businesses[0]!, resource_url: 'http://garage.example' }] }), /HTTPS origins/);
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses: [{ ...businesses[0]!, service_secret: 'short' }] }), /strong separate/);
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses: [{ ...businesses[0]!, business_id: 'bad/id' }] }), /unique IDs/);
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses: [businesses[0]!, { ...businesses[1]!, resource_url: businesses[0]!.resource_url }] }), /separate service origin/);
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses: [businesses[0]!, { ...businesses[1]!, service_secret: businesses[0]!.service_secret }] }), /separate service origin/);
    const identity = new CustomerIdentity(db, { issuer: 'http://127.0.0.1:1234', businesses: [] });
    assert.equal(identity.issuer, 'http://127.0.0.1:1234');
    assert.throws(() => new CustomerIdentity(db, { issuer, businesses }), /one persistent issuer/);
  } finally { db.close(); }
});

test('customer password sessions are separate from bots and legacy owner cookies and protect human writes', async t => {
  const f = await fixture(t), customer = await f.human();
  const connection = await f.connect(customer);
  const csrfHashBeforeReads = (f.db.prepare('SELECT csrf_hash FROM customer_identity_sessions').get() as { csrf_hash: string }).csrf_hash;
  assert.deepEqual(await (await f.call('/session')).json(), { customer: null });
  assert.deepEqual(await (await f.call('/session', undefined, { cookie: 'pneu007_session=legacy-owner-cookie' })).json(), { customer: null });
  assert.equal((await f.call('/profile', { name: 'Changed' }, { cookie: customer.cookie })).status, 403);
  assert.equal((await f.call('/profile', { name: 'Changed' }, { ...customer.headers, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.call('/profile', { name: 'Changed' }, { ...customer.headers, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.call('/profile', { name: 'Changed' }, { ...customer.headers, authorization: 'Bearer hcd_bot-credential' })).status, 403);
  const response = await f.call('/session', undefined, customer.headers), result = await response.json();
  assert.deepEqual(result.customer, { id: customer.id, email: 'customer@example.com', name: 'Jana', phone: '+420123456789' });
  assert.equal(result.customer.role, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(result.csrf_token, customer.csrf);
  const secondTab = await (await f.call('/session', undefined, { cookie: customer.cookie })).json();
  assert.equal(secondTab.csrf_token, customer.csrf, 'session reads preserve CSRF across tabs');
  assert.equal((await f.call('/profile', { name: 'Changed' }, customer.headers)).status, 200, 'opening a second tab does not invalidate earlier profile controls');
  const originalSessionRow = f.db.prepare('SELECT csrf_hash FROM customer_identity_sessions').get() as { csrf_hash: string };
  assert.notEqual(originalSessionRow.csrf_hash, customer.csrf, 'only CSRF hash is persisted');
  assert.equal(originalSessionRow.csrf_hash, csrfHashBeforeReads, 'session reads do not mutate persisted CSRF authority');
  assert.equal((await f.call(`/connections/${connection.connection_id}/revoke`, {}, customer.headers)).status, 200, 'earlier dashboard revoke controls still work after a second tab opens');
  const decision = await fetch(`${f.base}/api/handle/customer/decision`, { method: 'POST', headers: customer.headers });
  assert.equal(decision.status, 200, 'public human middleware protects approval proxy paths');
  assert.equal((await decision.json()).human.id, customer.id);
  assert.equal((await f.call('/logout', {}, customer.headers)).status, 200);
  assert.deepEqual(await (await f.call('/session', undefined, customer.headers)).json(), { customer: null });
  const login = await f.call('/login', { email: 'CUSTOMER@example.com', password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(login.headers.get('set-cookie')!, /Secure/);
  assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
  const loginResult = await login.json();
  assert.notEqual(loginResult.csrf_token, customer.csrf, 'new login rotates session and CSRF');
  const loggedIn = { cookie: login.headers.get('set-cookie')!.split(';')[0]! };
  assert.notEqual(loggedIn.cookie, customer.cookie);
  f.advance(12 * 60 * 60_000);
  assert.deepEqual(await (await f.call('/session', undefined, loggedIn)).json(), { customer: null });
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoru_owner_memberships'").get(), undefined);
});

test('explicit human agent consent narrows permissions, binds the customer once, and exchanges once', async t => {
  const f = await fixture(t), a = await f.human(), b = await f.human('other@example.com'), registration = await f.register();
  assert.equal(registration.expires_in, 600);
  assert.equal(new URL(registration.verification_uri).searchParams.get('connection'), registration.connection_id);
  assert(!registration.verification_uri.includes(registration.device_code));
  assert(!registration.verification_uri.includes(registration.user_code));
  const preview = await f.call(`/connections/${registration.connection_id}`, undefined, a.headers);
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).connection.scopes, ['a2a', 'customer.tools']);
  const exchange = () => f.call('/connections/exchange', { device_code: registration.device_code });
  assert.equal((await (await exchange()).json()).error, 'authorization_pending');
  assert.equal((await f.call(`/connections/${registration.connection_id}/approve`, { user_code: registration.user_code, scopes: ['a2a'], shared_fields: [] }, { authorization: 'Bearer hcd_bot' })).status, 403);
  assert.equal((await f.approve(registration, { ...a, headers: { cookie: a.cookie } })).status, 403);
  assert.equal((await f.approve(registration, a, ['a2a', 'owner.rules'])).status, 400);
  assert.equal((await f.approve(registration, a, ['a2a'], ['name', 'address'])).status, 400);
  assert.equal((await f.call(`/connections/${registration.connection_id}/approve`, { user_code: registration.user_code, scopes: ['a2a'], shared_fields: [], customer_id: b.id }, a.headers)).status, 400);
  assert.equal((await f.approve(registration, a, ['a2a'], [])).status, 200);
  assert.equal((await f.approve(registration, a)).status, 403);
  assert.equal((await f.approve(registration, b)).status, 403);
  assert.equal((await f.call(`/connections/${registration.connection_id}`, undefined, b.headers)).status, 404);
  assert.equal((await f.call(`/connections/${registration.connection_id}/revoke`, {}, b.headers)).status, 404);
  const credentials = await (await exchange()).json();
  assert.match(credentials.delegation_token, /^hcd_/);
  assert.equal(credentials.scope, 'a2a');
  assert.equal((await exchange()).status, 400);
  const token = await f.token(credentials.delegation_token), access = f.identity.introspect(token.access_token, businesses[0]!.service_secret);
  assert(access.active);
  assert.equal(access.scope, 'a2a');
  assert.deepEqual(access.profile, {});
  assert.deepEqual(access.shared_fields, []);
  assert.equal((await f.call('/token', { business_id: 'pneu-a', scope: 'a2a customer.tools' }, { authorization: `Bearer ${credentials.delegation_token}` })).status, 400);
  assert.throws(() => f.identity.accessForCustomer(b.id, 'pneu-a', registration.connection_id), /No active customer grant/);
  assert.throws(() => f.db.prepare('UPDATE customer_identity_connections SET customer_id=? WHERE id=?').run(b.id, registration.connection_id), /immutable/);
});

test('two businesses receive distinct bounded tokens and stable pairwise identity with only approved fields', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer);
  const a = await f.token(connection.delegation), b = await f.token(connection.delegation, 'pneu-b');
  assert.equal(a.expires_in, 600);
  assert.notEqual(a.access_token, b.access_token);
  const accessA = f.identity.introspect(a.access_token, businesses[0]!.service_secret), accessB = f.identity.introspect(b.access_token, businesses[1]!.service_secret);
  assert(accessA.active && accessB.active);
  assert.notEqual(accessA.sub, accessB.sub);
  assert.equal(accessA.aud, businesses[0]!.resource_url);
  assert.equal(accessB.aud, businesses[1]!.resource_url);
  assert.equal(accessA.client_id, connection.connection_id);
  assert.equal(accessA.iss, issuer);
  assert.deepEqual(accessA.profile, { name: 'Jana', email: 'customer@example.com' });
  assert.deepEqual(f.identity.introspect(a.access_token, businesses[1]!.service_secret), { active: false });
  assert.deepEqual(f.identity.introspect(b.access_token, businesses[0]!.service_secret), { active: false });
  assert.deepEqual(f.identity.introspect(connection.delegation, businesses[0]!.service_secret), { active: false });
  assert.deepEqual(f.identity.introspect(a.access_token, 'untrusted-service'), { active: false });
  assert.equal((await f.call('/token', { business_id: 'unregistered' }, { authorization: `Bearer ${connection.delegation}` })).status, 400);
  assert.equal((await f.call('/token', { business_id: 'pneu-a' }, { authorization: `Bearer ${a.access_token}` })).status, 401);
  const profile = await f.call('/profile', { email: 'new@example.com', name: 'Changed' }, customer.headers);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).customer.id, customer.id);
  const after = f.identity.introspect(a.access_token, businesses[0]!.service_secret);
  assert(after.active);
  assert.equal(after.sub, accessA.sub);
  assert.equal(after.profile.email, 'new@example.com');
  const renewed = await f.token(connection.delegation);
  const repeated = f.identity.introspect(renewed.access_token, businesses[0]!.service_secret);
  assert(repeated.active);
  assert.equal(repeated.sub, accessA.sub);
  const nextConnection = await f.connect(customer), next = await f.token(nextConnection.delegation);
  const replacement = f.identity.introspect(next.access_token, businesses[0]!.service_secret);
  assert(replacement.active);
  assert.equal(replacement.sub, accessA.sub, 'agent replacement keeps human customer subject');
  assert.notEqual(replacement.client_id, accessA.client_id);
  f.advance(600_000);
  assert.deepEqual(f.identity.introspect(a.access_token, businesses[0]!.service_secret), { active: false });
  assert.equal((await f.token(connection.delegation)).expires_in, 600, 'renewal needs no business login');
});

test('business and whole-agent revocation immediately block validation, context and renewal across restart', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer);
  const a = await f.token(connection.delegation), b = await f.token(connection.delegation, 'pneu-b');
  const accessA = f.identity.introspect(a.access_token, businesses[0]!.service_secret), accessB = f.identity.introspect(b.access_token, businesses[1]!.service_secret);
  assert(accessA.active && accessB.active);
  assert.deepEqual(f.identity.grantContext(businesses[0]!.service_secret, connection.connection_id, accessA.grant_id), accessA);
  assert.deepEqual(f.identity.grantContext(businesses[1]!.service_secret, connection.connection_id, accessA.grant_id), { active: false });
  assert.deepEqual(f.identity.grantContext(businesses[0]!.service_secret, 'other-agent', accessA.grant_id), { active: false });
  const wrongHuman = await f.human('other@example.com');
  assert.equal((await f.call(`/grants/${accessA.grant_id}/revoke`, {}, wrongHuman.headers)).status, 404);
  assert.equal((await f.call(`/grants/${accessA.grant_id}/revoke`, {}, customer.headers)).status, 200);
  assert.deepEqual(f.identity.introspect(a.access_token, businesses[0]!.service_secret), { active: false });
  assert.deepEqual(f.identity.grantContext(businesses[0]!.service_secret, connection.connection_id, accessA.grant_id), { active: false });
  assert.equal((await f.call('/token', { business_id: 'pneu-a' }, { authorization: `Bearer ${connection.delegation}` })).status, 403);
  assert(f.identity.introspect(b.access_token, businesses[1]!.service_secret).active);
  assert(f.identity.accessForCustomer(customer.id, 'pneu-b', connection.connection_id).active);
  const reopenedDb = new Database(f.filename);
  const restarted = new CustomerIdentity(reopenedDb, { issuer, businesses, now: f.now });
  assert.deepEqual(restarted.introspect(a.access_token, businesses[0]!.service_secret), { active: false });
  assert(restarted.introspect(b.access_token, businesses[1]!.service_secret).active);
  assert.equal((await f.call(`/connections/${connection.connection_id}/revoke`, {}, customer.headers)).status, 200);
  assert.deepEqual(restarted.introspect(b.access_token, businesses[1]!.service_secret), { active: false });
  assert.throws(() => restarted.accessForCustomer(customer.id, 'pneu-b', connection.connection_id), /No active customer grant/);
  assert.equal((await f.call('/token', { business_id: 'pneu-b' }, { authorization: `Bearer ${connection.delegation}` })).status, 401);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM customer_identity_grants').get() as { n: number }).n, 2, 'revocation does not delete historical grant records');
  reopenedDb.close();
});

test('issuer HTTP introspection supports forms, authenticates services, and rejects malformed/widened requests', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer), token = await f.token(connection.delegation);
  const form = (value: string, credential = businesses[0]!.service_secret) => fetch(`${f.base}${prefix}/introspect`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: value }) });
  const result = await form(token.access_token);
  assert.equal(result.status, 200, await result.clone().text());
  const access = await result.json() as CustomerAccess;
  assert(access.active);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await form('hca_nonexistent')).json(), { active: false });
  assert.deepEqual(await (await form(token.access_token, businesses[1]!.service_secret)).json(), { active: false });
  assert.equal((await form(token.access_token, connection.delegation)).status, 401);
  assert.equal((await f.call('/introspect', { token: token.access_token })).status, 401);
  const context = await f.call('/grant-context', { connection_id: connection.connection_id, grant_id: access.grant_id }, { authorization: `Bearer ${businesses[0]!.service_secret}` });
  assert.equal(context.status, 200);
  assert.equal((await context.json()).sub, access.sub);
  assert.equal((await f.call('/grant-context', { connection_id: connection.connection_id, grant_id: access.grant_id })).status, 401);
  const accessPage = await (await f.call('/access', undefined, customer.headers)).json();
  assert.equal(accessPage.connections[0].id, connection.connection_id);
  assert.equal(accessPage.grants[0].business_id, 'pneu-a');
  for (const value of [connection.device_code, connection.user_code, connection.delegation, token.access_token]) assert(!JSON.stringify(accessPage).includes(value));
  assert.equal((await f.call('/connections/register', { name: 'Agent', scopes: ['owner'] })).status, 400);
  assert.equal((await f.call('/connections/register', { name: 'x'.repeat(9000) })).status, 413);
  const malformed = await fetch(`${f.base}${prefix}/connections/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_request');
});

test('password, consent codes, sessions and bearer credentials are stored only as hashes and persist safely', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer), token = await f.token(connection.delegation);
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'customer_identity_%'").all() as { name: string }[];
  const contents = JSON.stringify(tables.map(table => f.db.prepare(`SELECT * FROM ${table.name}`).all()));
  const sessionToken = customer.cookie.slice('handle_customer_session='.length);
  for (const value of [password, customer.csrf, sessionToken, connection.device_code, connection.user_code, connection.delegation, token.access_token, ...businesses.map(business => business.service_secret)]) {
    assert(!contents.includes(JSON.stringify(value).slice(1, -1)), `database must not store literal secret ${value.slice(0, 3)}`);
  }
  assert.equal(statSync(f.filename).mode & 0o777, 0o600);
  const reopened = new Database(f.filename), identity = new CustomerIdentity(reopened, { issuer, businesses, now: f.now });
  assert.deepEqual(identity.introspect(token.access_token, businesses[0]!.service_secret), f.identity.introspect(token.access_token, businesses[0]!.service_secret));
  assert.equal((await f.call('/connections/exchange', { device_code: connection.device_code })).status, 400);
  reopened.close();
  const duplicate = await f.call('/signup', { email: 'customer@example.com', password });
  assert.equal(duplicate.status, 409);
  const other = await f.human('other@example.com');
  assert.equal((await f.call('/profile', { email: 'customer@example.com' }, other.headers)).status, 409);
});

test('expired requests and consent fail closed; wrong codes and login attempts have bounded rates', async t => {
  const f = await fixture(t), customer = await f.human(), expired = await f.register();
  f.advance(600_000);
  assert.equal((await f.approve(expired, customer)).status, 403);
  assert.equal((await f.call('/connections/exchange', { device_code: expired.device_code })).status, 400);
  const locked = await f.register(), wrongCode = locked.user_code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await f.approve({ ...locked, user_code: wrongCode }, customer)).status, 403);
  assert.equal((await f.approve(locked, customer)).status, 403);
  const active = await f.connect(customer), token = await f.token(active.delegation);
  f.advance(30 * 24 * 60 * 60_000);
  assert.deepEqual(f.identity.introspect(token.access_token, businesses[0]!.service_secret), { active: false });
  assert.equal((await f.call('/token', { business_id: 'pneu-a' }, { authorization: `Bearer ${active.delegation}` })).status, 401);
  assert.equal((await f.call('/login', { email: 'customer@example.com', password: 'incorrect-password' })).status, 401);
  for (let i = 1; i < 10; i++) await f.call('/login', { email: 'customer@example.com', password: 'incorrect-password' });
  const limited = await f.call('/login', { email: 'customer@example.com', password });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  for (let i = 0; i < 20; i++) await f.register();
  assert.equal((await f.call('/connections/register', { name: 'Agent' })).status, 429);
});

test('only central human decision tickets authorize the exact mandate once for the intended live business', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer);
  await f.token(connection.delegation);
  await f.token(connection.delegation, 'pneu-b');
  const mandateId = 'mandate-001', mandateHash = 'a'.repeat(64), serviceA = businesses[0]!.service_secret, serviceB = businesses[1]!.service_secret;
  const ticket = f.identity.createMandateDecision(customer.id, 'pneu-a', connection.connection_id, mandateId, mandateHash);
  assert.match(ticket, /^hcm_/);
  const stored = f.db.prepare('SELECT * FROM customer_identity_mandate_decisions').get() as { token_hash: string; expires_at: number; consumed: number };
  assert(!JSON.stringify(stored).includes(ticket));
  assert.equal(stored.token_hash.length, 64);
  assert(stored.expires_at <= f.now().getTime() + 120_000);
  assert.equal(stored.consumed, 0);
  const body = { ticket, mandate_id: mandateId, mandate_hash: mandateHash };
  assert.equal((await f.call('/mandate-decisions/create', body, { authorization: `Bearer ${serviceA}` })).status, 404, 'business cannot mint a human decision over HTTP');
  assert.equal((await f.call('/mandate-decisions/consume', body)).status, 401);
  assert.deepEqual(f.identity.consumeMandateDecision(serviceA, 'hcm_forged', mandateId, mandateHash), { active: false });
  assert.deepEqual(f.identity.consumeMandateDecision(serviceB, ticket, mandateId, mandateHash), { active: false });
  assert.deepEqual(f.identity.consumeMandateDecision(serviceA, ticket, 'other-mandate', mandateHash), { active: false });
  assert.deepEqual(f.identity.consumeMandateDecision(serviceA, ticket, mandateId, 'b'.repeat(64)), { active: false });
  assert.equal((f.db.prepare('SELECT consumed FROM customer_identity_mandate_decisions').get() as { consumed: number }).consumed, 0, 'wrong target and binding cannot burn the ticket');
  const consumed = await f.call('/mandate-decisions/consume', body, { authorization: `Bearer ${serviceA}` });
  assert.equal(consumed.status, 200, await consumed.clone().text());
  const access = await consumed.json() as CustomerAccess;
  assert(access.active);
  assert.equal(access.business_id, 'pneu-a');
  assert.equal(access.connection_id, connection.connection_id);
  assert.deepEqual(f.identity.consumeMandateDecision(serviceA, ticket, mandateId, mandateHash), { active: false });
  assert.deepEqual(await (await f.call('/mandate-decisions/consume', body, { authorization: `Bearer ${serviceA}` })).json(), { active: false });
  assert.throws(() => f.identity.createMandateDecision('other-customer', 'pneu-a', connection.connection_id, mandateId, mandateHash), /No active customer grant/);
  assert.throws(() => f.identity.createMandateDecision(customer.id, 'pneu-a', connection.connection_id, mandateId, 'invalid-hash'), /Invalid mandate decision binding/);
});

test('human mandate tickets expire, survive restart and lose authority when grant or connection is revoked', async t => {
  const f = await fixture(t), customer = await f.human(), connection = await f.connect(customer);
  await f.token(connection.delegation);
  await f.token(connection.delegation, 'pneu-b');
  const mandateId = 'mandate-002', mandateHash = 'b'.repeat(64), serviceA = businesses[0]!.service_secret, serviceB = businesses[1]!.service_secret;
  const expired = f.identity.createMandateDecision(customer.id, 'pneu-a', connection.connection_id, mandateId, mandateHash);
  f.advance(120_000);
  assert.deepEqual(f.identity.consumeMandateDecision(serviceA, expired, mandateId, mandateHash), { active: false });
  const ticketA = f.identity.createMandateDecision(customer.id, 'pneu-a', connection.connection_id, mandateId, mandateHash);
  const ticketB = f.identity.createMandateDecision(customer.id, 'pneu-b', connection.connection_id, mandateId, mandateHash);
  const reopenedDb = new Database(f.filename), restarted = new CustomerIdentity(reopenedDb, { issuer, businesses, now: f.now });
  const accessA = f.identity.accessForCustomer(customer.id, 'pneu-a', connection.connection_id);
  assert.equal((await f.call(`/grants/${accessA.grant_id}/revoke`, {}, customer.headers)).status, 200);
  assert.deepEqual(restarted.consumeMandateDecision(serviceA, ticketA, mandateId, mandateHash), { active: false });
  assert.throws(() => f.identity.createMandateDecision(customer.id, 'pneu-a', connection.connection_id, mandateId, mandateHash), /No active customer grant/);
  assert(restarted.consumeMandateDecision(serviceB, ticketB, mandateId, mandateHash).active, 'valid unconsumed ticket survives restart');
  const revokedConnectionTicket = f.identity.createMandateDecision(customer.id, 'pneu-b', connection.connection_id, mandateId, mandateHash);
  assert.equal((await f.call(`/connections/${connection.connection_id}/revoke`, {}, customer.headers)).status, 200);
  assert.deepEqual(restarted.consumeMandateDecision(serviceB, revokedConnectionTicket, mandateId, mandateHash), { active: false });
  reopenedDb.close();
});
