import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostedDiscovery } from '../src/hosted-discovery.js';
import type { DocumentFetcher } from '../src/website-discovery.js';

const candidates = [{ name: 'Garage', website: 'https://garage.example.com' }];
const missing: DocumentFetcher = async url => ({ url, status: 404, headers: {}, body: '' });
test('hosted scanner uses safe discovery contract and never logs failed response bodies', async () => {
  const scan = createHostedDiscovery({ fetchDocument: missing });
  const result = await scan({ candidates, service: 'tyre_change', area: 'Prague 6', limit: 1 });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as any).request, { service: 'tyre_change', area: 'Prague 6' });
  assert.equal((result.body as any).candidates[0].status, 'not_found');
});
test('hosted scanner strictly validates before accepting a batch', async () => {
  let requests = 0;
  const scan = createHostedDiscovery({ fetchDocument: async (...args) => { requests++; return missing(...args); } });
  for (const body of [null, [], {}, { candidates: [] }, { candidates, token: 'secret' }, { candidates, limit: 11 }, { candidates, limit: '1' }, { candidates, limit: null },
    { candidates, service: false }, { candidates, area: ' ' }, { candidates: Array.from({ length: 11 }, () => candidates[0]) }, { candidates: [{ ...candidates[0], extra: true }] }]) {
    assert.deepEqual(await scan(body), { status: 400, body: { error: 'Invalid discovery request' } });
  }
  assert.equal(requests, 0);
  assert.equal((await scan({ candidates })).status, 200);
});
test('hosted scanner enforces eight accepted batches per minute with bounded rolling timestamps', async () => {
  let now = 0;
  const scan = createHostedDiscovery({ fetchDocument: missing, now: () => now });
  for (let i = 0; i < 8; i++) assert.equal((await scan({ candidates })).status, 200);
  assert.deepEqual(await scan({ candidates }), { status: 429, body: { error: 'Discovery is busy; retry later' }, retryAfter: 60 });
  now = 59_999; assert.equal((await scan({ candidates })).status, 429);
  now = 60_000; assert.equal((await scan({ candidates })).status, 200);
});
test('hosted scanner allows two active batches, rejects queueing and frees capacity on completion', async () => {
  const releases: (() => void)[] = [];
  const scan = createHostedDiscovery({ fetchDocument: async (url, options) => {
    if (url.includes('/.well-known/')) await new Promise<void>(resolve => releases.push(resolve));
    return missing(url, options);
  } });
  const first = scan({ candidates }), second = scan({ candidates });
  assert.equal((await scan({ candidates })).status, 429);
  assert.equal(releases.length, 2);
  releases.shift()!(); assert.equal((await first).status, 200);
  const third = scan({ candidates });
  releases.shift()!(); releases.shift()!();
  assert.equal((await second).status, 200); assert.equal((await third).status, 200);
});
test('hosted scanner preserves private network blocks and reports incomplete coverage', async () => {
  let requests = 0;
  const scan = createHostedDiscovery({ fetchDocument: async (...args) => { requests++; return missing(...args); } });
  const result = await scan({ candidates: [{ name: 'Private', website: 'https://127.0.0.1/' }] });
  assert.equal(result.status, 200);
  assert.equal((result.body as any).candidates[0].status, 'blocked');
  assert.equal((result.body as any).coverage.incomplete, true);
  assert.equal(requests, 0);
});
