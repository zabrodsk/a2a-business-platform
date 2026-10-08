import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createRegistry } from '../src/server.js';

const admin = 'admin-token-with-at-least-24-characters';
async function fixture(publicUrl: string | undefined = 'https://registry.example') {
  let clock = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'registry-enrollment-'));
  const dbPath = join(directory, 'registry.db');
  const registry = createRegistry({ dbPath, port: 0, host: '127.0.0.1', adminToken: admin, publicUrl }, { now: () => clock, startHealthTimer: false });
  const server = registry.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method = 'POST', body?: unknown, token?: string) {
    const response = await fetch(base + path, { method, headers: { host: 'attacker.example', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() as Record<string, string> };
  }
  const publisher = await request('/api/publishers', 'POST', { name: 'Test business' }, admin);
  return { request, publisher: publisher.data, dbPath, advance(ms: number) { clock += ms; }, async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); registry.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('publisher enrollment is admin-only, bound to PUBLIC_URL and strictly validated', async () => {
  const f = await fixture();
  try {
    const input = { publisher_id: f.publisher.publisher_id };
    for (const token of [undefined, 'wrong', f.publisher.token]) assert.equal((await f.request('/api/publisher-enrollments', 'POST', input, token)).status, 401);
    for (const ttl of [0, 901, 1.5, '300']) assert.equal((await f.request('/api/publisher-enrollments', 'POST', { ...input, ttl_seconds: ttl }, admin)).status, 400);
    assert.equal((await f.request('/api/publisher-enrollments', 'POST', { ...input, extra: true }, admin)).status, 400);
    assert.equal((await f.request('/api/publisher-enrollments', 'POST', { publisher_id: 'unknown' }, admin)).status, 404);
    const issued = await f.request('/api/publisher-enrollments', 'POST', input, admin);
    assert.equal(issued.status, 201); assert.equal(issued.cache, 'no-store');
    assert.match(issued.data.redeem_url!, /^https:\/\/registry.example\/publisher-enrollments\/[A-Za-z0-9_-]{43}$/);
    const db = new Database(f.dbPath, { readonly: true });
    try {
      const stored = JSON.stringify(db.prepare('SELECT * FROM publisher_enrollments').all());
      assert.ok(!stored.includes(issued.data.redeem_url!.split('/').at(-1)!));
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('redemption burns once, rotates the publisher token, and GET does not redeem', async () => {
  const f = await fixture();
  try {
    const issue = await f.request('/api/publisher-enrollments', 'POST', { publisher_id: f.publisher.publisher_id }, admin);
    const path = new URL(issue.data.redeem_url!).pathname;
    assert.equal((await f.request(path, 'GET')).status, 404);
    const results = await Promise.all([f.request(path), f.request(path)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 404]);
    const redeemed = results.find(result => result.status === 200)!;
    assert.equal(redeemed.cache, 'no-store'); assert.equal(redeemed.data.role, 'publisher'); assert.equal(redeemed.data.registry_url, 'https://registry.example');
    assert.match(redeemed.data.token!, /^publisher_[A-Za-z0-9_-]{43}$/);
    assert.equal((await f.request('/api/me/businesses', 'GET', undefined, f.publisher.token)).status, 401);
    assert.equal((await f.request('/api/me/businesses', 'GET', undefined, redeemed.data.token)).status, 200);
    const db = new Database(f.dbPath, { readonly: true });
    try { assert.ok(!JSON.stringify(db.prepare('SELECT * FROM publishers').all()).includes(redeemed.data.token!)); } finally { db.close(); }
  } finally { await f.close(); }
});

test('enrollment expires at its deadline and replacement revokes old codes', async () => {
  const f = await fixture();
  try {
    const body = { publisher_id: f.publisher.publisher_id, ttl_seconds: 1 };
    const old = await f.request('/api/publisher-enrollments', 'POST', body, admin);
    const next = await f.request('/api/publisher-enrollments', 'POST', body, admin);
    assert.equal((await f.request(new URL(old.data.redeem_url!).pathname)).status, 404);
    f.advance(1000);
    const expired = await f.request(new URL(next.data.redeem_url!).pathname);
    assert.equal(expired.status, 404); assert.ok(!JSON.stringify(expired.data).includes(next.data.redeem_url!));
    assert.equal((await f.request('/api/me/businesses', 'GET', undefined, f.publisher.token)).status, 200);
  } finally { await f.close(); }
});

test('issuance requires a configured secure public origin', async () => {
  for (const url of ['', 'http://registry.example', 'https://registry.example/path', 'https://user:secret@registry.example', 'https://registry.example?secret=1']) {
    const f = await fixture(url);
    try { assert.equal((await f.request('/api/publisher-enrollments', 'POST', { publisher_id: f.publisher.publisher_id }, admin)).status, 503); }
    finally { await f.close(); }
  }
});
