import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createRegistry } from '../src/server.js';

const card = { name: 'Garage agent', description: 'Quote metadata', skills: [{ id: 'quote', name: 'Quotes', description: 'Quotes only' }],
  supportedInterfaces: [{ url: 'https://garage.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] };
test('registry public hosted scanner is bounded, credential-free and separate from listing enrollment', async t => {
  const calls: string[] = [];
  const registry = createRegistry({ dbPath: ':memory:', port: 0, host: '127.0.0.1', adminToken: 'hosted-test-admin-token-with-24-characters' }, {
    startHealthTimer: false, discoveryFetchDocument: async url => { calls.push(url); return { url, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) }; },
  });
  const server = registry.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); registry.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = (body: string) => fetch(origin + '/discovery/websites', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const candidates = [{ name: 'Garage', website: 'https://garage.example.com' }];
  const first = await submit(JSON.stringify({ candidates }));
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
  const listingSearch = await fetch(origin + '/api/search');
  assert.equal((await listingSearch.json() as any).total, 0);
});
