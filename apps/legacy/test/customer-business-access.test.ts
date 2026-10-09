import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { CustomerBusinessAccess } from '../src/customer-business-access.js';

const now = () => new Date('2026-10-09T08:00:00Z');
const valid = () => ({ active: true, iss: 'https://handle.example', sub: 'pairwise-customer', aud: 'https://garage.example', client_id: 'personal-agent',
  exp: now().getTime() / 1000 + 600, scope: 'a2a customer.tools', business_id: 'garage', connection_id: 'connection-1', grant_id: 'grant-1',
  shared_fields: ['email'], profile: { email: 'customer001@example.test' } });
function fixture(t: TestContext, value: unknown = valid(), fail = false) {
  const store = new LegacyStore(':memory:', { now });
  t.after(() => store.close());
  const calls: RequestInit[] = [];
  const request = (async (_url: unknown, options: RequestInit) => {
    calls.push(options);
    if (fail) throw new Error('issuer offline');
    return Response.json(value);
  }) as typeof fetch;
  const access = new CustomerBusinessAccess(store.db, { issuer: 'https://handle.example', resource_url: 'https://garage.example', business_id: 'garage',
    service_secret: 'synthetic-business-service-secret-0123456789', nativeBusinessId: () => 'pneu007', now, request });
  return { store, access, calls };
}

test('pinned introspection creates one customer mapping without merging by email', async t => {
  const f = fixture(t);
  const first = await f.access.authenticate('hca_synthetic-token');
  const again = await f.access.authenticate('hca_synthetic-token');
  assert.equal(first.actor.customer_id, again.actor.customer_id);
  assert.notEqual(first.actor.customer_id, 'customer-001');
  assert.equal(first.actor.id, 'personal-agent');
  assert.equal(first.actor.business_id, 'pneu007');
  assert.equal(f.calls.length, 2, 'every operation must check current issuer state');
  assert(f.calls.every(call => call.redirect === 'error'));
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM customer_identity_mappings').get() as { n: number }).n, 1);
});

test('malformed, foreign, expired and excessive-lifetime identity responses fail before mapping', async t => {
  const invalid = [
    { active: false }, { ...valid(), iss: 'https://attacker.example' }, { ...valid(), aud: 'https://other.example' },
    { ...valid(), business_id: 'other-garage' }, { ...valid(), sub: '' }, { ...valid(), client_id: '' },
    { ...valid(), connection_id: '' }, { ...valid(), grant_id: '' }, { ...valid(), exp: now().getTime() / 1000 },
    { ...valid(), exp: now().getTime() / 1000 + 601 }, { ...valid(), scope: 'a2a owner' },
    { ...valid(), shared_fields: [], profile: { email: 'unapproved@example.test' } },
  ];
  for (const value of invalid) {
    const f = fixture(t, value);
    await assert.rejects(f.access.authenticate('hca_synthetic-token'));
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM customer_identity_mappings').get() as { n: number }).n, 0);
  }
});

test('issuer outage denies access and does not create a customer', async t => {
  const f = fixture(t, valid(), true);
  await assert.rejects(f.access.authenticate('hca_synthetic-token'), /unavailable/i);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM customer_identity_mappings').get() as { n: number }).n, 0);
});

async function listen(t: TestContext, app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('A2A scope follows Express case-insensitive matching on direct and managed routes', async t => {
  const f = fixture(t, { ...valid(), scope: 'customer.tools' });
  const app = express();
  app.use(f.access.middleware);
  app.post(['/a2a/jsonrpc', '/relay/:id/a2a'], (_req, res) => res.json({ allowed: true }));
  app.use((error: { status: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status).end());
  const base = await listen(t, app);
  for (const path of ['/a2a/jsonrpc', '/A2A/jsonrpc', '/relay/relay-1/a2a', '/relay/relay-1/A2A', '/RELAY/relay-1/a2a']) {
    assert.equal((await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer hca_synthetic-token' } })).status, 403, path);
  }
});

test('interleaved customers retain separate request-local authenticated identities across awaits', async t => {
  const store = new LegacyStore(':memory:', { now });
  t.after(() => store.close());
  const request = (async (_url: unknown, options: RequestInit) => {
    const token = JSON.parse(String(options.body)).token;
    return Response.json({ ...valid(), sub: 'subject-' + token, client_id: 'agent-' + token });
  }) as typeof fetch;
  const access = new CustomerBusinessAccess(store.db, { issuer: 'https://handle.example', resource_url: 'https://garage.example', business_id: 'garage',
    service_secret: 'synthetic-business-service-secret-0123456789', nativeBusinessId: () => 'pneu007', now, request });
  const app = express();
  app.use(access.middleware);
  let entered = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  app.get('/api/identity/:own/:other', async (req, res) => {
    if (++entered === 2) release();
    await both;
    assert.equal(access.identify(String(req.params.other)), undefined);
    res.json({ actor: access.identify(String(req.params.own)) });
  });
  const base = await listen(t, app);
  const results = await Promise.all(['hca_A', 'hca_B'].map(async (token, i) => {
    const other = i ? 'hca_A' : 'hca_B';
    const response = await fetch(`${base}/api/identity/${token}/${other}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.equal(results[0].actor.id, 'agent-hca_A');
  assert.equal(results[1].actor.id, 'agent-hca_B');
  assert.notEqual(results[0].actor.customer_id, results[1].actor.customer_id);
  assert.equal(access.identify('hca_A'), undefined);
  assert.equal(access.identify('hca_B'), undefined);
});
