import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadLegacyConfig } from '../src/config.js';
import { createLegacy } from '../src/server.js';

const card = { name: 'Garage agent', description: 'Quote metadata', skills: [{ id: 'quote', name: 'Quotes', description: 'Quotes only' }],
  supportedInterfaces: [{ url: 'https://garage.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] };
test('business public hosted scanner requires no business/customer credentials and preserves API authentication', async t => {
  const calls: string[] = [];
  const config = loadLegacyConfig({ LEGACY_DB_PATH: ':memory:', PAYMENT_PROVIDER: 'local_demo', LEGACY_RECONCILIATION_MS: '60000' });
  const system = createLegacy(config, { discoveryFetchDocument: async url => { calls.push(url); return { url, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) }; } });
  const server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await system.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = (body: string) => fetch(origin + '/discovery/websites', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const candidates = [{ name: 'Garage', website: 'https://garage.example.com' }];
  const first = await submit(JSON.stringify({ candidates, area: 'Prague 6' }));
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal((await first.json() as any).candidates[0].status, 'compatible');
  assert.deepEqual(calls, ['https://garage.example.com/.well-known/agent-card.json']);
  for (const body of ['{"secret-token":', JSON.stringify({ candidates, token: 'secret-token' }), ' '.repeat(32769)]) {
    const response = await submit(body);
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Invalid discovery request' });
  }
  const privateSite = await submit(JSON.stringify({ candidates: [{ name: 'Private', website: 'https://127.0.0.1/' }] }));
  const privateResult = await privateSite.json() as any;
  assert.equal(privateResult.candidates[0].status, 'blocked'); assert.equal(privateResult.coverage.incomplete, true);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 6; i++) assert.equal((await submit(JSON.stringify({ candidates }))).status, 200);
  const limited = await submit(JSON.stringify({ candidates }));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(origin + '/api/agent/reservations')).status, 401);
});
