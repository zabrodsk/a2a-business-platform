import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { RelayDb } from '../src/db.js';
import { Doorbell } from '../src/doorbell.js';
import { botRouter } from '../src/bot-api.js';
import { hashToken } from '../src/auth.js';
import type { RelayExecutor } from '../src/executor.js';

const TOKEN = 'business-test-token-0123456789';
const OTHER = 'other-business-token-012345678';
const KEY = 'secret-webhook-key-0123456789';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fixture(t: { after: (fn: () => Promise<void>) => void }, persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wakeup-'));
  const dbPath = persistent ? join(dir, 'relay.db') : ':memory:';
  const calls: any[] = [];
  let respond: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const hook = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls.push({ body: JSON.parse(raw), authorization: req.headers.authorization });
      if (respond?.(req, res)) return;
      if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://127.0.0.1:9/secret-target' }).end();
      // Deliberately echo secrets: neither the API response nor event log may retain them.
      res.end(JSON.stringify({ key: KEY, ...JSON.parse(raw) }));
    });
  });
  await new Promise<void>(resolve => hook.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/private/hook`;
  const cfg = loadConfig({ BUSINESS_TOKEN: TOKEN, PUSH_HOST_ALLOWLIST: '127.0.0.1,api2.cursor.sh', DB_PATH: dbPath, RERING_MS: '20' });
  cfg.tokens.set(OTHER, { id: 'garage-demo', role: 'business' });
  let db = new RelayDb(dbPath);
  let doorbell = new Doorbell(cfg, db);
  let app = express();
  app.use('/bot', botRouter(cfg, db, doorbell, {} as RelayExecutor));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path = '/doorbell', body?: unknown, token = TOKEN, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}/bot${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  t.after(async () => {
    doorbell.stop();
    server.closeAllConnections();
    hook.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => hook.close(() => resolve()));
    await db.kysely.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  return { cfg, calls, url, request, setRespond(fn: typeof respond) { respond = fn; }, get db() { return db; }, get doorbell() { return doorbell; }, async restart() {
    doorbell.stop();
    await db.kysely.destroy();
    db = new RelayDb(dbPath);
    doorbell = new Doorbell(cfg, db);
    app = express();
    app.use('/bot', botRouter(cfg, db, doorbell, {} as RelayExecutor));
    server.removeAllListeners('request');
    server.on('request', app);
  } };
}

test('HTTP 200 stays pending until same-credential one-use proof; no secrets in status or logs', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request()).body, { configured: false, ready: false, verification_state: 'unconfigured' });
  const registered = await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  assert.equal(registered.status, 200);
  assert.deepEqual(registered.body.test_ring, { status: 200 });
  assert.equal(registered.body.wakeup.verification_state, 'pending');
  const token = f.calls[0].body.setup_probe.token;
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(f.calls[0].body.pending, 0);
  assert.equal(f.calls[0].authorization, `Bearer ${KEY}`);
  const pending = (await f.request()).body;
  assert.equal(pending.ready, false);
  assert.match(pending.webhook_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await f.request('/doorbell', undefined, OTHER)).body.verification_state, 'unverified');
  assert.equal((await f.request('/doorbell/ack', { probe_token: token }, OTHER)).status, 400);
  assert.equal((await f.request('/doorbell/ack', { probe_token: 'wrong' })).status, 400);
  assert.equal((await f.request('/doorbell/ack', { probe_token: token })).body.ready, true);
  assert.equal((await f.request('/doorbell/ack', { probe_token: token })).status, 400);
  const output = JSON.stringify([registered.body, pending, (await f.request()).body, f.db.listEvents({})]);
  for (const secret of [KEY, TOKEN, token, f.url, hashToken(TOKEN)]) assert.ok(!output.includes(secret), 'secret in safe response/event');
  const verification = f.db.getSetting('business_webhook_verification')!;
  assert.ok(!verification.includes(token));
  assert.deepEqual(JSON.parse(verification).probe_hashes, []);
});

test('hook and credential replacement revoke proof; stale and expired probes fail', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  const token = f.calls[0].body.setup_probe.token;
  await f.request('/doorbell', { url: f.url, key: `${KEY}-changed`, test: true });
  assert.equal((await f.request('/doorbell/ack', { probe_token: token })).status, 400);
  const fresh = f.calls[1].body.setup_probe.token;
  assert.equal((await f.request('/doorbell/ack', { probe_token: fresh })).status, 200);
  await f.request('/doorbell', { url: f.url, key: `${KEY}-changed` }, OTHER);
  assert.equal((await f.request('/doorbell', undefined, OTHER)).body.verification_state, 'unverified');
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  const expired = f.calls.at(-1).body.setup_probe.token;
  const v = JSON.parse(f.db.getSetting('business_webhook_verification')!);
  v.expires_at = Date.now() - 1;
  f.db.setSetting('business_webhook_verification', JSON.stringify(v));
  assert.equal((await f.request()).body.verification_state, 'expired');
  assert.equal((await f.request('/doorbell/ack', { probe_token: expired })).status, 400);
});

test('pending and verified proof survive restart; delete disables environment fallback too', async t => {
  const f = await fixture(t, true);
  f.cfg.businessWebhook = { url: f.url, key: KEY };
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  const token = f.calls[0].body.setup_probe.token;
  await f.restart();
  assert.equal((await f.request()).body.verification_state, 'pending');
  assert.equal((await f.request('/doorbell/ack', { probe_token: token })).status, 200);
  await f.restart();
  assert.equal((await f.request()).body.ready, true);
  await f.request('/doorbell', undefined, TOKEN, 'DELETE');
  await f.restart();
  assert.equal((await f.request()).body.verification_state, 'unconfigured');
  assert.equal(f.db.getSetting('business_webhook_verification'), undefined);
});

test('setup retries after 15s without customer work, delayed probe remains valid, stop halts timer', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  const first = f.calls[0].body.setup_probe.token;
  f.doorbell.startReringLoop();
  f.doorbell.startReringLoop();
  await sleep(100);
  assert.equal(f.calls.length, 1);
  const deadline = Date.now() + 16_000;
  while (f.calls.length < 2 && Date.now() < deadline) await sleep(100);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.pending, 0);
  assert.notEqual(f.calls[1].body.setup_probe.token, first);
  assert.equal((await f.request('/doorbell/ack', { probe_token: first })).status, 200);
  f.doorbell.stop();
  const v = JSON.parse(f.db.getSetting('business_webhook_verification')!);
  assert.deepEqual(v.probe_hashes, []);
});

test('URL policy denies userinfo, fragments, production custom ports and redirects; roles are dynamic', async t => {
  const f = await fixture(t);
  for (const url of ['https://user:password@api2.cursor.sh/hook', 'https://api2.cursor.sh/hook#secret', 'https://api2.cursor.sh:444/hook', 'http://api2.cursor.sh/hook', 'http://127.0.0.1.evil/hook', 'ftp://127.0.0.1/hook']) {
    assert.equal((await f.request('/doorbell', { url, key: KEY })).status, 400, url);
  }
  const redirected = await f.request('/doorbell', { url: new URL('/redirect', f.url).toString(), key: KEY, test: true });
  assert.deepEqual(redirected.body.test_ring, { error: 'webhook request failed' });
  assert.equal(redirected.body.wakeup.ready, false);
  f.cfg.lookupAgentToken = token => token === 'dynamic-business-token-123456' ? { id: 'fresh-business', role: 'business' } : undefined;
  assert.equal((await f.request('/doorbell', undefined, 'dynamic-business-token-123456')).status, 200);
  f.cfg.lookupAgentToken = () => undefined;
  assert.equal((await f.request('/doorbell', undefined, 'dynamic-business-token-123456')).status, 401);
  f.cfg.tokens.set(OTHER, { id: 'customer', role: 'customer' });
  assert.equal((await f.request('/doorbell', undefined, OTHER)).status, 403);
});

test('ordinary work_pending payload stays unchanged and has no setup challenge', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY });
  f.doorbell.ring('customer_message');
  for (let i = 0; i < 20 && !f.calls.length; i++) await sleep(10);
  assert.deepEqual(f.calls[0].body, { event: 'work_pending', pending: 0, reason: 'customer_message' });
  assert.equal((await f.request()).body.verification_state, 'unverified');
});

test('managed status, probe ack and ringing respect live connection scopes and execution epoch', async t => {
  const f = await fixture(t);
  let epoch = 1;
  let active = true;
  let scope = true;
  f.cfg.businessId = 'managed-test-shop';
  f.cfg.lookupToken = token => token === TOKEN ? {
    id: 'managed-agent', role: 'business', business_id: 'managed-test-shop',
    connection_id: 'connection-1', execution_epoch: epoch, scopes: scope ? ['doorbell.write'] : [],
  } : undefined;
  f.cfg.checkIdentity = (identity, operation) => active && identity.execution_epoch === epoch &&
    (!operation || operation !== 'doorbell.write' || scope);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  assert.equal(JSON.parse(f.db.getSetting('business_webhook')!).identity.connection_id, 'connection-1');
  const first = f.calls[0].body.setup_probe.token;
  assert.equal((await f.request('/doorbell/ack', { probe_token: first })).status, 200);
  assert.equal((await f.request()).body.ready, true);
  // Same bearer and URL/key cannot preserve proof across owner-approved handover.
  epoch = 2;
  assert.equal((await f.request()).body.ready, false);
  assert.equal((await f.request('/doorbell/ack', { probe_token: first })).status, 400);
  await f.request('/doorbell', { url: f.url, key: KEY });
  assert.equal((await f.request()).body.verification_state, 'unverified');
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  const second = f.calls.at(-1).body.setup_probe.token;
  scope = false;
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request('/doorbell/ack', { probe_token: second })).status, 403);
  assert.equal((await f.request('/doorbell', undefined, TOKEN, 'DELETE')).status, 403);
  const count = f.calls.length;
  f.doorbell.ring('revoked-scope');
  await sleep(20);
  assert.equal(f.calls.length, count);
  scope = true;
  active = false;
  assert.equal((await f.request()).status, 403);
  assert.equal(f.doorbell.webhook(), undefined);
});

test('managed webhook rejects unbound persisted or environment callbacks', async t => {
  const f = await fixture(t);
  f.cfg.businessWebhook = { url: f.url, key: KEY };
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  f.cfg.businessId = 'fresh-managed-business';
  assert.equal(f.doorbell.webhook(), undefined);
  assert.equal(f.doorbell.status(hashToken(TOKEN)).ready, false);
  assert.equal(f.doorbell.acknowledge(f.calls[0].body.setup_probe.token, hashToken(TOKEN)), false);
  f.db.setSetting('business_webhook', undefined);
  assert.equal(f.doorbell.webhook(), undefined);
});


test('failed current delivery removes readiness; automatic probe and acknowledgment restore it', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  await f.request('/doorbell/ack', { probe_token: f.calls[0].body.setup_probe.token });
  f.setRespond((_req, res) => { res.writeHead(503).end('temporarily unavailable'); return true; });
  f.doorbell.ring('customer_message');
  for (let i = 0; i < 50 && (await f.request()).body.ready; i++) await sleep(10);
  assert.equal((await f.request()).body.verification_state, 'pending');
  f.setRespond(undefined);
  // Advance only Date; real HTTP and the existing 20ms test rering loop continue.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(15_000);
  f.doorbell.startReringLoop();
  for (let i = 0; i < 50 && !f.calls.at(-1).body.setup_probe; i++) await sleep(10);
  const probe = f.calls.at(-1).body.setup_probe;
  assert.ok(probe);
  assert.equal((await f.request()).body.ready, false);
  assert.equal((await f.request('/doorbell/ack', { probe_token: probe.token })).body.ready, true);
});

test('stale in-flight failure from old callback does not damage verified replacement', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  await f.request('/doorbell/ack', { probe_token: f.calls[0].body.setup_probe.token });
  let delayed: ServerResponse | undefined;
  f.setRespond((req, res) => {
    if (req.url === '/private/hook') { delayed = res; return true; }
    return false;
  });
  f.doorbell.ring('old_customer_message');
  for (let i = 0; i < 50 && !delayed; i++) await sleep(10);
  assert.ok(delayed);
  await f.request('/doorbell', { url: new URL('/replacement', f.url).toString(), key: `${KEY}-new`, test: true });
  await f.request('/doorbell/ack', { probe_token: f.calls.at(-1).body.setup_probe.token });
  const replacement = (await f.request()).body;
  assert.equal(replacement.ready, true);
  delayed.writeHead(503).end();
  await sleep(30);
  assert.deepEqual((await f.request()).body, replacement);
});

test('network failure also rearms a verified callback without exposing provider errors', async t => {
  const f = await fixture(t);
  await f.request('/doorbell', { url: f.url, key: KEY, test: true });
  await f.request('/doorbell/ack', { probe_token: f.calls[0].body.setup_probe.token });
  f.setRespond((req) => { req.socket.destroy(); return true; });
  f.doorbell.ring('customer_message');
  for (let i = 0; i < 50 && (await f.request()).body.ready; i++) await sleep(10);
  assert.equal((await f.request()).body.verification_state, 'pending');
  const event = f.db.listEvents({}).find(event => event.kind === 'doorbell_failed');
  assert.deepEqual(event?.detail, { reason: 'customer_message', pending: 0, error: 'webhook request failed' });
});
