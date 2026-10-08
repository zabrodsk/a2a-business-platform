import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { assertPublicUrl, fetchPublicJson, isPublicAddress } from '../src/remote.js';

test('accepts ordinary public IPv4 and IPv6 unicast addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('blocks private, special-purpose and transition addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '100.127.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.9',
    '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd00::1',
    'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '2001:db8::1',
    '2001:20::1', '3fff::1', 'not-an-address',
  ]) assert.equal(isPublicAddress(address), false, address);
});

test('URL validation closes literal, encoding, protocol, port and hostname bypasses', () => {
  for (const value of [
    'http://example.com/card', 'https://user:pass@example.com/card', 'https://example.com:444/card',
    'https://example.com/card#fragment', 'https://example.com/card#', 'https://localhost/card', 'https://garage.local/card',
    'https://garage.internal./card', 'https://garage/card', 'https://127.0.0.1/card',
    'https://127.1/card', 'https://2130706433/card', 'https://0x7f000001/card',
    'https://[::1]/card', 'https://[::ffff:7f00:1]/card', 'https://%6cocalhost/card',
    'https://public.example.com@localhost/card', 'garbage',
  ]) assert.throws(() => assertPublicUrl(value), Error, value);
  assert.equal(assertPublicUrl('https://example.com:443/card').href, 'https://example.com/card');
});

function mockRemote(t: TestContext, options: {
  addresses?: { address: string; family: number }[];
  status?: number;
  type?: string;
  body?: Buffer | string;
  contentLength?: string;
} = {}) {
  const calls: { url: URL; options: https.RequestOptions }[] = [];
  const lookup = t.mock.method(dns, 'lookup', async () => options.addresses ?? [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(https, 'get', (url: URL, requestOptions: https.RequestOptions, callback: (response: unknown) => void) => {
    calls.push({ url, options: requestOptions });
    const request = Object.assign(new EventEmitter(), { destroy() {} });
    const response = Object.assign(Readable.from([Buffer.from(options.body ?? '{"ok":true}')]), {
      statusCode: options.status ?? 200,
      headers: { 'content-type': options.type ?? 'application/json', 'content-length': options.contentLength },
      complete: true,
    });
    queueMicrotask(() => callback(response));
    return request;
  });
  return { calls, lookup };
}

test('pins vetted DNS to socket lookup and sends no authentication', async t => {
  const { calls, lookup } = mockRemote(t);
  assert.deepEqual(await fetchPublicJson('https://example.com/card'), { ok: true });
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.family, 4);
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
  const pinned = calls[0].options.lookup!;
  let target: unknown;
  pinned('example.com', {}, (error, address, family) => {
    assert.equal(error, null);
    target = { address, family };
  });
  assert.deepEqual(target, { address: '93.184.216.34', family: 4 });
  assert.equal(lookup.mock.callCount(), 1);
});

test('rejects mixed public/private DNS results before opening a socket', async t => {
  const { calls } = mockRemote(t, { addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /Private or reserved/);
  assert.equal(calls.length, 0);
});

test('rejects empty DNS results', async t => {
  const { calls } = mockRemote(t, { addresses: [] });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /Private or reserved/);
  assert.equal(calls.length, 0);
});

test('never follows redirects', async t => {
  const { calls } = mockRemote(t, { status: 302 });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /without redirects/);
  assert.equal(calls.length, 1);
});

test('rejects oversized streaming responses', async t => {
  mockRemote(t, { body: Buffer.alloc(256 * 1024 + 1, 32) });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /size limit/);
});

test('rejects oversized content length before reading', async t => {
  mockRemote(t, { contentLength: '999999' });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /size limit/);
});

test('accepts structured JSON media types', async t => {
  mockRemote(t, { type: 'application/agent+json; charset=utf-8' });
  assert.deepEqual(await fetchPublicJson('https://example.com/card'), { ok: true });
});

test('rejects non-JSON content types', async t => {
  mockRemote(t, { type: 'text/html' });
  await assert.rejects(fetchPublicJson('https://example.com/card'), /JSON content type/);
});

test('does not expose remote content in JSON errors', async t => {
  mockRemote(t, { body: 'secret remote value' });
  await assert.rejects(fetchPublicJson('https://example.com/card'), { message: 'Remote document contains invalid JSON' });
});

test('deadline includes stalled DNS and prevents a late connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls } = mockRemote(t);
  let resolveLookup!: (addresses: { address: string; family: number }[]) => void;
  t.mock.method(dns, 'lookup', () => new Promise(resolve => { resolveLookup = resolve; }));
  const fetched = fetchPublicJson('https://example.com/card');
  const rejected = assert.rejects(fetched, /timed out/);
  t.mock.timers.tick(5_000);
  await rejected;
  resolveLookup([{ address: '93.184.216.34', family: 4 }]);
  await Promise.resolve();
  assert.equal(calls.length, 0);
});
