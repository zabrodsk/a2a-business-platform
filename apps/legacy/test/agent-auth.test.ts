import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response, type NextFunction } from 'express';
import { BusinessError, type Actor } from '../../../packages/contracts/index.js';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { LegacyAuth } from '../src/auth.js';
import { AgentAuth } from '../src/agent-auth.js';

const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim';
const password = 'human-password-for-auth-tests';
const configuredToken = 'configured-agent-secret-0123456789';
const emailA = 'jana.vesela@example.com';
const emailB = 'martin.dvorak@example.com';
type Session = { cookie: string; 'x-csrf-token': string };
type RegistrationResponse = {
  registration_id: string; claim_token: string; identity_assertion?: string;
  pre_claim_scopes?: string[]; post_claim_scopes: string[];
  claim?: { user_code: string; verification_uri: string; interval: number; expires_in: number };
};
type Claim = NonNullable<RegistrationResponse['claim']>;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-agent-auth-'));
  const filename = join(dir, 'auth.sqlite');
  let clock = Date.parse('2026-10-09T08:00:00Z');
  const now = () => new Date(clock);
  const store = new LegacyStore(filename, { now });
  const agentAuth = new AgentAuth(store.db, { publicUrl: 'https://garage.example', now });
  const auth = new LegacyAuth(store.db, { now, publicOrigin: 'https://garage.example',
    lookupAgentToken: token => agentAuth.identify(token),
    agentTokens: new Map<string, Actor>([[configuredToken, { id: 'configured-customer-agent', role: 'customer_agent', customer_id: 'customer-001' }]]),
    users: [
      { username: 'a', password, actor: { id: 'human-a', role: 'human_customer', customer_id: 'customer-001' } },
      { username: 'b', password, actor: { id: 'human-b', role: 'human_customer', customer_id: 'customer-002' } },
    ] });
  const app = express();
  app.use('/api', express.json({ limit: '512kb' }), auth.middleware, auth.protect);
  app.use(agentAuth.router(auth));
  app.post('/api/login', (req, res) => res.json(auth.login(req, res)));
  app.get('/api/customer', auth.require('customer_agent'), (req, res) => res.json(req.legacyActor));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof BusinessError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
    else if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') res.status(error.status).json({ error: 'invalid_request' });
    else res.status(500).json({ error: String(error) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (path: string, data?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const form = (path: string, data: Record<string, string>) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data),
  });
  const exchange = (assertion: string) => form('/oauth2/token', { grant_type: JWT_GRANT, assertion });
  const poll = (claim_token: string) => form('/oauth2/token', { grant_type: CLAIM_GRANT, claim_token });
  const register = async (type: 'anonymous' | 'service_auth' = 'anonymous', login_hint = emailA) => {
    const response = await call('/agent/identity', { type, ...(type === 'service_auth' ? { login_hint } : {}) });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as RegistrationResponse;
  };
  const login = async (username = 'a'): Promise<Session> => {
    const response = await call('/api/login', { username, password });
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': session.csrf_token };
  };
  const attemptToken = (claim: Claim) => new URL(claim.verification_uri).searchParams.get('claim_attempt_token')!;
  const confirm = (claim: Claim, session: Session, code = claim.user_code) => call('/api/agent/identity/confirm', { claim_attempt_token: attemptToken(claim), user_code: code }, session);
  const start = async (registration: RegistrationResponse) => {
    const response = await call('/agent/identity/claim', { claim_token: registration.claim_token, email: emailA });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).claim_attempt as Claim;
  };
  return { ...store, agentAuth, auth, call, form, exchange, poll, register, login, attemptToken, confirm, start, filename, now, base,
    advance: (ms: number) => { clock += ms; } };
}

test('discovery advertises only implemented registration types and bounded identity-only preclaim access', async t => {
  const f = await fixture(t);
  const metadata = await (await f.call('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.agent_auth.identity_types_supported, ['anonymous', 'service_auth']);
  assert.equal(metadata.agent_auth.events_endpoint, undefined);
  assert.equal(metadata.agent_auth.identity_assertion, undefined);
  assert.deepEqual(metadata.grant_types_supported, [JWT_GRANT, CLAIM_GRANT]);
  assert.equal(metadata.token_endpoint, 'https://garage.example/oauth2/token');
  assert.match(await (await f.call('/auth.md')).text(), /agent\.identity/);
  assert.equal((await f.call('/agent/identity', { type: 'identity_assertion', assertion: 'forged' })).status, 400);
  assert.equal((await f.call('/agent/identity', { type: 'anonymous', customer_id: 'customer-001' })).status, 400);
  assert.equal((await f.call('/agent/identity', { type: 'anonymous', scopes: ['customer.tools'] })).status, 400);
  assert.equal((await f.call('/agent/identity', { type: 'anonymous', padding: 'x'.repeat(9000) })).status, 413);
  const malformed = await fetch(`${f.base}/agent/identity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_request');
  const registration = await f.register();
  assert.deepEqual(registration.pre_claim_scopes, ['agent.identity']);
  const assertion = registration.identity_assertion!;
  const [header, payload, signature] = assertion.split('.');
  assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg, 'EdDSA');
  const stored = f.db.prepare('SELECT private_key FROM agent_auth_keys').get() as { private_key: string };
  assert(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey(createPrivateKey(stored.private_key)), Buffer.from(signature!, 'base64url')));
  const response = await f.exchange(assertion);
  assert.equal(response.status, 200, await response.clone().text());
  const credentials = await response.json();
  assert.equal(credentials.scope, 'agent.identity');
  assert.deepEqual(f.agentAuth.identify(credentials.access_token), { id: registration.registration_id, role: 'unclaimed_agent' });
  const headers = { authorization: `Bearer ${credentials.access_token}` };
  assert.deepEqual(await (await f.call('/api/agent/identity', undefined, headers)).json(), {
    agent: { id: registration.registration_id, role: 'unclaimed_agent' }, acting_for: null,
  });
  assert.equal((await f.call('/api/customer', undefined, headers)).status, 403);
  const missing = await f.call('/api/agent/identity');
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate')!, /oauth-protected-resource/);
  const configured = await f.call('/api/agent/identity', undefined, { authorization: `Bearer ${configuredToken}` });
  assert.deepEqual((await configured.json()).acting_for, { type: 'customer', id: 'customer-001' });
});

test('service_auth withholds credentials and avoids revealing whether an email has an account', async t => {
  const f = await fixture(t);
  for (const email of [emailA, 'unregistered@example.com']) {
    const registration = await f.register('service_auth', email);
    assert.equal(registration.identity_assertion, undefined);
    assert.match(registration.claim!.user_code, /^\d{6}$/);
    assert.equal(registration.claim!.expires_in, 600);
    assert.equal(registration.claim!.interval, 5);
    assert.equal(new URL(registration.claim!.verification_uri).pathname, '/agent/claim');
    const pending = await f.poll(registration.claim_token);
    assert.equal(pending.status, 400);
    assert.equal((await pending.json()).error, 'authorization_pending');
    const fast = await f.poll(registration.claim_token);
    assert.equal((await fast.json()).error, 'slow_down');
    const unsupported = await f.call('/agent/identity/claim', { claim_token: registration.claim_token, email });
    assert.equal((await unsupported.json()).error, 'claimed_or_in_flight');
  }
});

test('human claim enforces account, code, session and CSRF before upgrading stable identity', async t => {
  const f = await fixture(t);
  const registration = await f.register();
  const pre = await (await f.exchange(registration.identity_assertion!)).json();
  const claim = await f.start(registration);
  const a = await f.login(), b = await f.login('b');
  const query = `/api/agent/identity/claim-request?claim_attempt_token=${f.attemptToken(claim)}`;
  assert.equal((await f.call(query)).status, 403);
  assert.equal((await f.call(query, undefined, b)).status, 403);
  const request = await f.call(query, undefined, a);
  assert.equal(request.status, 200);
  assert.deepEqual((await request.json()).scopes, ['agent.identity', 'a2a', 'customer.tools']);
  assert.equal((await f.confirm(claim, b)).status, 403);
  assert.equal((await f.confirm(claim, { ...a, 'x-csrf-token': '' })).status, 403);
  const bearer = await f.call('/api/agent/identity/confirm', { claim_attempt_token: f.attemptToken(claim), user_code: claim.user_code }, { authorization: `Bearer ${configuredToken}` });
  assert.equal(bearer.status, 403);
  const combined = await f.call('/api/agent/identity/confirm', { claim_attempt_token: f.attemptToken(claim), user_code: claim.user_code }, { ...a, authorization: `Bearer ${configuredToken}` });
  assert.equal(combined.status, 403);
  const forged = await f.call('/api/agent/identity/confirm', { claim_attempt_token: f.attemptToken(claim), user_code: claim.user_code, customer_id: 'customer-002' }, a);
  assert.equal(forged.status, 400);
  const wrong = claim.user_code === '000000' ? '000001' : '000000';
  assert.equal((await f.confirm(claim, a, wrong)).status, 403);
  assert.deepEqual(f.agentAuth.identify(pre.access_token), { id: registration.registration_id, role: 'unclaimed_agent' });
  assert.equal((await f.confirm(claim, a)).status, 200);
  assert.equal(f.agentAuth.identify(pre.access_token), undefined);
  assert.equal((await f.exchange(pre.identity_assertion)).status, 400);
  assert.equal((await f.confirm(claim, a)).status, 403);
  const poll = await f.poll(registration.claim_token);
  assert.equal(poll.status, 200, await poll.clone().text());
  const post = await poll.json();
  assert.equal(post.scope, 'agent.identity a2a customer.tools');
  assert.deepEqual(f.agentAuth.identify(post.access_token), { id: registration.registration_id, role: 'customer_agent', customer_id: 'customer-001' });
  const actor = await f.call('/api/customer', undefined, { authorization: `Bearer ${post.access_token}` });
  assert.equal(actor.status, 200);
  assert.equal((await actor.json()).customer_id, 'customer-001');
  assert.equal((await (await f.poll(registration.claim_token)).json()).error, 'expired_token');
  const exchanged = await f.exchange(post.identity_assertion);
  assert.equal(exchanged.status, 200);
  const refreshed = await exchanged.json();
  assert.equal((await f.exchange(post.identity_assertion)).status, 400);
  assert.equal((await f.exchange(refreshed.identity_assertion)).status, 200);
  assert.throws(() => f.db.prepare('UPDATE agent_auth_registrations SET customer_id=? WHERE id=?').run('customer-002', registration.registration_id), /immutable/);
});

test('assertion validation rejects tampering, replay, expiry and cross-service audiences', async t => {
  const f = await fixture(t), registration = await f.register();
  const assertion = registration.identity_assertion!;
  const parts = assertion.split('.');
  const unsigned = `${Buffer.from(JSON.stringify({ typ: 'oauth-id-jag+jwt', alg: 'none' })).toString('base64url')}.${parts[1]}.AA`;
  assert.equal((await f.exchange(unsigned)).status, 400);
  assert.equal((await f.exchange(`${parts[0]}.${parts[1]}.AAAA`)).status, 400);
  assert.equal((await f.exchange('not-a-jwt')).status, 400);
  const otherIssuer = new AgentAuth(f.db, { publicUrl: 'https://other.example', now: f.now });
  const app = express();
  app.use(otherIssuer.router(f.auth));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: JWT_GRANT, assertion }),
  });
  assert.equal(response.status, 400);
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  const valid = await f.exchange(assertion);
  assert.equal(valid.status, 200);
  const credentials = await valid.json();
  assert.equal((await f.exchange(assertion)).status, 400);
  f.advance(60 * 60_000);
  assert.equal(f.agentAuth.identify(credentials.access_token), undefined);
  const refresh = await f.exchange(credentials.identity_assertion);
  assert.equal(refresh.status, 200, 'replacement assertion outlives the access credential');
  const refreshed = await refresh.json();
  f.advance(24 * 60 * 60_000);
  assert.equal((await f.exchange(refreshed.identity_assertion)).status, 400);
});

test('claim expiry, replacement URLs and registration expiry fail closed', async t => {
  const f = await fixture(t), registration = await f.register(), a = await f.login();
  const first = await f.start(registration);
  f.advance(10 * 60_000);
  assert.equal((await f.confirm(first, a)).status, 403);
  assert.equal((await (await f.poll(registration.claim_token)).json()).error, 'expired_token');
  const second = await f.start(registration);
  assert.notEqual(f.attemptToken(first), f.attemptToken(second));
  assert.equal((await f.confirm(first, a)).status, 403);
  assert.equal((await f.confirm(second, a)).status, 200);
  const claimed = await (await f.poll(registration.claim_token)).json();
  assert(f.agentAuth.identify(claimed.access_token));
  const expired = await f.register();
  f.advance(24 * 60 * 60_000);
  assert.equal((await f.call('/agent/identity/claim', { claim_token: expired.claim_token, email: emailA })).status, 400);
  const row = f.db.prepare('SELECT status FROM agent_auth_registrations WHERE id=?').get(expired.registration_id) as { status: string };
  assert.equal(row.status, 'expired');
});

test('five invalid codes lock the ceremony and registration endpoints enforce rate limits', async t => {
  const f = await fixture(t), registration = await f.register('service_auth'), a = await f.login();
  const claim = registration.claim!;
  const wrong = claim.user_code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await f.confirm(claim, a, wrong)).status, 403);
  assert.equal((await f.confirm(claim, a)).status, 403);
  assert.equal((await (await f.poll(registration.claim_token)).json()).error, 'expired_token');
  for (let i = 1; i < 20; i++) await f.register();
  const limited = await f.call('/agent/identity', { type: 'anonymous' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('token revocation and customer-owned registration revocation remove authority', async t => {
  const f = await fixture(t), registration = await f.register('service_auth'), a = await f.login(), b = await f.login('b');
  assert.equal((await f.confirm(registration.claim!, a)).status, 200);
  const tokens = await (await f.poll(registration.claim_token)).json();
  const next = await (await f.exchange(tokens.identity_assertion)).json();
  assert.equal((await f.form('/oauth2/revoke', { token: tokens.access_token })).status, 200);
  assert.equal(f.agentAuth.identify(tokens.access_token), undefined);
  assert(f.agentAuth.identify(next.access_token));
  assert.equal((await f.form('/oauth2/revoke', { token: 'unknown-token' })).status, 200);
  const own = await (await f.call('/api/agent/identities', undefined, a)).json();
  assert.equal(own.identities.length, 1);
  assert.equal(own.identities[0].registration_id, registration.registration_id);
  assert.deepEqual((await (await f.call('/api/agent/identities', undefined, b)).json()).identities, []);
  assert.equal((await f.call(`/api/agent/identities/${registration.registration_id}/revoke`, {}, b)).status, 404);
  assert.equal((await f.call(`/api/agent/identities/${registration.registration_id}/revoke`, {}, { ...a, 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.call(`/api/agent/identities/${registration.registration_id}/revoke`, {}, a)).status, 200);
  assert.equal(f.agentAuth.identify(next.access_token), undefined);
  assert.equal((await f.exchange(next.identity_assertion)).status, 400);
});

test('signing identity, token hashes, binding and replay protection survive reopening the database', async t => {
  const f = await fixture(t), registration = await f.register('service_auth'), a = await f.login();
  assert.equal((await f.confirm(registration.claim!, a)).status, 200);
  const credentials = await (await f.poll(registration.claim_token)).json();
  const audit = JSON.stringify(f.db.prepare('SELECT * FROM audit_events').all());
  const claims = JSON.stringify(f.db.prepare('SELECT * FROM agent_auth_claim_attempts').all());
  const registrations = JSON.stringify(f.db.prepare('SELECT * FROM agent_auth_registrations').all());
  const storedTokens = JSON.stringify(f.db.prepare('SELECT * FROM agent_auth_access_tokens').all());
  for (const suffix of ['', '-wal', '-shm']) {
    const filename = `${f.filename}${suffix}`;
    assert(existsSync(filename), 'persistent SQLite database and WAL/SHM files exist');
    assert.equal(statSync(filename).mode & 0o777, 0o600, 'signing key database files are private to their owner');
  }
  for (const value of [registration.claim_token, registration.claim!.user_code, f.attemptToken(registration.claim!), credentials.access_token, credentials.identity_assertion]) {
    const literal = JSON.stringify(value);
    assert(!audit.includes(literal), 'audit does not contain bearer secrets');
    assert(!claims.includes(literal), 'claim attempts store hashes only');
    assert(!registrations.includes(literal), 'registrations store claim hashes only');
    assert(!storedTokens.includes(literal), 'access credentials store hashes only');
  }
  const reopened = new LegacyStore(f.filename, { now: f.now });
  t.after(() => reopened.db.close());
  const persisted = new AgentAuth(reopened.db, { publicUrl: 'https://garage.example', now: f.now });
  assert.deepEqual(persisted.identify(credentials.access_token), { id: registration.registration_id, role: 'customer_agent', customer_id: 'customer-001' });
  const exchange = await f.exchange(credentials.identity_assertion);
  assert.equal(exchange.status, 200);
  const next = await exchange.json();
  const used = reopened.db.prepare('SELECT COUNT(*) AS n FROM agent_auth_assertion_uses').get() as { n: number };
  assert.equal(used.n, 1);
  const app = express();
  app.use(persisted.router(f.auth));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  const reopenedExchange = (assertion: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: JWT_GRANT, assertion }),
  });
  assert.equal((await reopenedExchange(credentials.identity_assertion)).status, 400);
  const refreshed = await reopenedExchange(next.identity_assertion);
  assert.equal(refreshed.status, 200, 'a restarted signer accepts an assertion issued by its predecessor');
  assert.equal(persisted.identify((await refreshed.json()).access_token)?.id, registration.registration_id);
});
