import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fetchPublicDocument } from '../src/public-web.js';

function mockRemote(t: TestContext, routes: Record<string, { status?: number; location?: string; body?: string | Buffer; headers?: Record<string, string> }>) {
  const calls: { url: URL; options: https.RequestOptions }[] = [];
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(https, 'get', (url: URL, options: https.RequestOptions, callback: (value: unknown) => void) => {
    calls.push({ url, options });
    const route = routes[url.href] ?? {};
    const request = Object.assign(new EventEmitter(), { destroy() {} });
    const response = Object.assign(Readable.from([Buffer.from(route.body ?? 'hello')]), {
      statusCode: route.status ?? 200, headers: { 'content-type': 'text/html', location: route.location, ...route.headers }, complete: true,
    });
    queueMicrotask(() => callback(response));
    return request;
  });
  return { calls, lookup };
}
const base = 'https://garage.example.com/';
test('public document exposes only safe headers and never sends credentials or cookies', async t => {
  const remote = mockRemote(t, { [base]: { headers: { 'set-cookie': 'secret', link: '</agent.json>; rel="agent-card"' } } });
  const document = await fetchPublicDocument(base);
  assert.deepEqual(document.headers, { 'content-type': 'text/html', link: '</agent.json>; rel="agent-card"' });
  assert.deepEqual(remote.calls[0].options.headers, { Accept: 'application/json, text/html, text/plain' });
  assert.equal(remote.calls[0].options.agent, false);
});
test('redirect following requires opt-in', async t => {
  const remote = mockRemote(t, { [base]: { status: 302, location: '/next' } });
  const doc = await fetchPublicDocument(base);
  assert.equal(doc.status, 302);
  assert.equal(doc.body, '');
  assert.equal(remote.calls.length, 1);
});
test('redirects resolve and pin DNS independently, without forwarding cookies', async t => {
  const remote = mockRemote(t, { [base]: { status: 302, location: 'https://cards.example.com/agent.json', headers: { 'set-cookie': 'secret' } } });
  let budget = 0;
  const doc = await fetchPublicDocument(base, { followRedirects: true, onRequest: () => { budget++; } });
  assert.equal(doc.url, 'https://cards.example.com/agent.json');
  assert.equal(remote.lookup.mock.callCount(), 2);
  assert.equal(budget, 2);
  assert.ok(!JSON.stringify(remote.calls[1].options.headers).includes('secret'));
  let pinned: unknown;
  remote.calls[1].options.lookup!('cards.example.com', {}, (_err, address) => { pinned = address; });
  assert.equal(pinned, '93.184.216.34');
});
test('blocks redirected private, credentialed and non-HTTPS URLs before connection', async t => {
  for (const location of ['https://127.0.0.1/admin', 'https://user:secret@cards.example.com/', 'http://cards.example.com/']) {
    const remote = mockRemote(t, { [base]: { status: 302, location } });
    await assert.rejects(fetchPublicDocument(base, { followRedirects: true }), /Unsafe/);
    assert.equal(remote.calls.length, 1);
    t.mock.restoreAll();
  }
});
test('blocks a redirect whose DNS resolves to private addresses', async t => {
  const remote = mockRemote(t, { [base]: { status: 302, location: 'https://private.example.com/' } });
  remote.lookup.mock.mockImplementation(async (hostname: unknown) => [{ address: hostname === 'private.example.com' ? '10.0.0.1' : '93.184.216.34', family: 4 }]);
  await assert.rejects(fetchPublicDocument(base, { followRedirects: true }), /Private or reserved/);
  assert.equal(remote.calls.length, 1);
});
test('caps redirects at three and includes hops in caller budget', async t => {
  const remote = mockRemote(t, { [base]: { status: 302, location: '/1' }, [base + '1']: { status: 302, location: '/2' }, [base + '2']: { status: 302, location: '/3' }, [base + '3']: { status: 302, location: '/4' } });
  await assert.rejects(fetchPublicDocument(base, { followRedirects: true }), /redirect limit/);
  assert.equal(remote.calls.length, 4);
});
test('caller request budget prevents a redirected connection', async t => {
  const remote = mockRemote(t, { [base]: { status: 302, location: '/1' } });
  let count = 0;
  await assert.rejects(fetchPublicDocument(base, { followRedirects: true, onRequest: () => { if (++count > 1) throw new Error('limit'); } }), /request limit/);
  assert.equal(remote.calls.length, 1);
});
test('returns bounded 404 and 503 evidence without remote error bodies', async t => {
  for (const status of [404, 503]) {
    mockRemote(t, { [base]: { status, body: 'private error details' } });
    const doc = await fetchPublicDocument(base);
    assert.equal(doc.status, status); assert.equal(doc.body, '');
    t.mock.restoreAll();
  }
});
test('bounds document bytes', async t => {
  mockRemote(t, { [base]: { body: Buffer.alloc(101) } });
  await assert.rejects(fetchPublicDocument(base, { maxBytes: 100 }), /size limit/);
});
test('deadline includes DNS and prevents a late socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = mockRemote(t, {});
  let resolve!: (records: { address: string; family: number }[]) => void;
  t.mock.method(dns, 'lookup', () => new Promise(done => { resolve = done; }));
  const fetching = fetchPublicDocument(base, { timeoutMs: 30 });
  const rejected = assert.rejects(fetching, /timed out/);
  t.mock.timers.tick(30); await rejected;
  resolve([{ address: '93.184.216.34', family: 4 }]); await Promise.resolve();
  assert.equal(remote.calls.length, 0);
});
