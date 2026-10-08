// End-to-end: real relay over HTTP + the bundled CLIs as black boxes.
// Scripted "bots" stand in for the GrokBots here; this proves the transport, not the agents.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createRelay } from '../src/server.js';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const A2A = join(ROOT, 'packages/agent-client/dist/a2a.mjs');
const INBOX = join(ROOT, 'packages/agent-client/dist/inbox.mjs');

const TOK = {
  a: 'customer-a-token-0123456789',
  b: 'customer-b-token-0123456789',
  biz: 'business-token-0123456789ab',
  admin: 'admin-token-0123456789abcd',
};
const HOOK_KEY = 'crsr_test_hook_key_123456';

let base = '';
let relay: ReturnType<typeof createRelay>;
let server: Server;
let hookServer: Server;
const hookCalls: Array<{ path: string; auth?: string; body: any }> = [];
let tmp = '';

function cli(bin: string, args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
  );
}
const asA = (args: string[]) => cli(A2A, args, { A2A_CREDENTIALS_FILE: join(tmp, 'cred-a.json') });
const asB = (args: string[]) => cli(A2A, args, { A2A_CREDENTIALS_FILE: join(tmp, 'cred-b.json') });
const biz = (args: string[]) => cli(INBOX, args, { RELAY_URL: base, RELAY_TOKEN: TOK.biz });
const taskIdOf = (out: string) => /task:\s+(\S+)/.exec(out)?.[1] ?? assert.fail(`no task id in:\n${out}`);
const itemIdOf = (out: string) => /=== work item (\S+)/.exec(out)?.[1] ?? assert.fail(`no work item in:\n${out}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  assert.ok(existsSync(A2A) && existsSync(INBOX), 'build the CLIs first: npm run build -w @pneu007/agent-client');
  tmp = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
  const dbPath = join(tmp, 'relay.db');
  const mig = spawnSync('npx', ['a2a-db', 'upgrade', '--url', `sqlite:${dbPath}`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(mig.status, 0, mig.stderr);

  hookServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hookCalls.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  const hookBase = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;

  // Port is needed in the card before listen, so reserve one first.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;

  const cfg = loadConfig({
    PORT: String(port),
    PUBLIC_URL: base,
    DB_PATH: dbPath,
    CUSTOMER_TOKENS: `customer-a:${TOK.a},customer-b:${TOK.b}`,
    BUSINESS_TOKEN: TOK.biz,
    ADMIN_TOKEN: TOK.admin,
    BUSINESS_WEBHOOK_URL: `${hookBase}/business-doorbell`,
    BUSINESS_WEBHOOK_KEY: 'business-hook-key-xyz',
    PUSH_HOST_ALLOWLIST: '127.0.0.1',
    REPLY_WAIT_MS: '4000',
    MAX_AGENT_TURNS: '3',
  });
  relay = createRelay(cfg);
  server = relay.app.listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  writeFileSync(join(tmp, 'cred-a.json'), JSON.stringify({ [base]: TOK.a }));
  writeFileSync(join(tmp, 'cred-b.json'), JSON.stringify({ [base]: TOK.b }));
});

after(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => hookServer?.close(r));
  await relay?.close();
});

test('discover reads the live card and reports the endpoint and credential', async () => {
  const r = await asA(['discover', `${base}/some/page`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`endpoint:\\s+${base}/a2a/jsonrpc\\s+\\[JSONRPC, A2A 1.0\\]`));
  assert.match(r.out, /credential: present/);
});

test('agent card is spec-shaped ProtoJSON and declares only what we implement', async () => {
  const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  assert.deepEqual(card.supportedInterfaces, [{ url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
  assert.ok(!JSON.stringify(card).includes('$case'));
  assert.equal(card.capabilities.streaming, false);
  const text = JSON.stringify(card);
  for (const secret of [...Object.values(TOK), 'business-hook-key-xyz']) assert.ok(!text.includes(secret), 'secret in public card');
  assert.ok(!/2472|discount|sleva/i.test(text), 'internal pricing rules in public card');
});

test('discover fails loudly when there is no card', async () => {
  const r = await asA(['discover', 'http://127.0.0.1:9']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /No agent card found/);
});

test('website: visiting agents find the shop agent from the page itself', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('link') ?? '', /\/\.well-known\/agent-card\.json>; rel="agent-card"/);
  const html = await res.text();
  assert.match(html, /<link rel="agent-card" type="application\/json" href="[^"]+\/\.well-known\/agent-card\.json">/);
  assert.match(html, /For AI agents: talk to our agent/);
  assert.match(html, /A2A \(Agent2Agent\) v1\.0/);
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  assert.match(llms, /Agent Card: http:\/\/127\.0\.0\.1:\d+\/\.well-known\/agent-card\.json/);
  const d = await asA(['discover', `${base}/`]);
  assert.match(d.out, /found via:\s+well-known URI \(A2A standard\)/);
});

test('website hosted elsewhere: discover follows <link rel="agent-card"> or the Link header', async () => {
  const pages: Record<string, { headers?: Record<string, string>; body: string }> = {
    '/html-link': { body: `<html><head><link rel="agent-card" href="${base}/.well-known/agent-card.json"></head><body>Shop</body></html>` },
    '/header-link': { headers: { link: `<${base}/.well-known/agent-card.json>; rel="agent-card"` }, body: '<html><body>Shop</body></html>' },
    '/nothing': { body: '<html><body>Just a shop</body></html>' },
  };
  const site = createServer((req, res) => {
    const p = pages[req.url ?? ''];
    if (!p) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html', ...(p.headers ?? {}) }).end(p.body);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  try {
    for (const path of ['/html-link', '/header-link']) {
      const d = await asA(['discover', `${siteBase}${path}`]);
      assert.equal(d.code, 0, d.err);
      assert.match(d.out, /found via:\s+rel="agent-card" link on the page/);
      assert.match(d.out, new RegExp(`endpoint:\\s+${base}/a2a/jsonrpc`));
      assert.match(d.out, /credential: present/);
    }
    const none = await asA(['discover', `${siteBase}/nothing`]);
    assert.notEqual(none.code, 0);
    assert.match(none.err, /no rel="agent-card" link/);
  } finally {
    await new Promise((r) => site.close(r));
  }
});

test('blocking send returns when the business replies; multi-turn; completion with data', async () => {
  const sending = asA(['send', base, 'Hi, I need 4 tyres changed, 18" alloy. Price?']);
  const got = await biz(['wait', '--timeout', '20']);
  assert.equal(got.code, 0, got.err);
  assert.match(got.out, /\[customer\] Hi, I need 4 tyres changed/);
  const item1 = itemIdOf(got.out);
  const rep = await biz(['reply', item1, 'Base price is 2472 CZK. Which day suits you?']);
  assert.match(rep.out, /Sent\. Task \S+ is now input-required/);

  const first = await sending;
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /state: TASK_STATE_INPUT_REQUIRED/);
  assert.match(first.out, /\[agent\] Base price is 2472 CZK/);
  const taskId = taskIdOf(first.out);

  // Doorbell: business webhook was rung with the business key and no customer text.
  const ring = hookCalls.find((c) => c.path === '/business-doorbell');
  assert.ok(ring, 'doorbell not rung');
  assert.equal(ring.auth, 'Bearer business-hook-key-xyz');
  assert.equal(ring.body.event, 'work_pending');
  assert.ok(!JSON.stringify(ring.body).includes('tyres'));

  // Customer may not speak while it is the business's turn.
  const second = asA(['send', base, 'Friday 16 October please', '--task', taskId]);
  const item2 = itemIdOf((await biz(['wait', '--timeout', '20'])).out);
  const early = await asA(['send', base, 'hello??', '--task', taskId, '--no-wait']);
  assert.notEqual(early.code, 0);
  assert.match(early.err, /waiting for the agent/);

  const done = await biz([
    'reply', item2, 'Booked Fri 16 Oct 16:00.', '--state', 'completed',
    '--data', '{"booking_id":"bk-1","total_minor":247200,"currency":"CZK"}',
  ]);
  assert.match(done.out, /now completed/);
  const fin = await second;
  assert.equal(fin.code, 0, fin.err);
  assert.match(fin.out, /state: TASK_STATE_COMPLETED/);
  assert.match(fin.out, /\[artifact result\] Booked Fri 16 Oct 16:00\./);
  assert.match(fin.out, /"booking_id":"bk-1"/);

  // Replying twice to the same work item changes nothing.
  const dup = await biz(['reply', item2, 'again']);
  assert.match(dup.out, /Already answered/);

  // A terminal task accepts no more messages.
  const closed = await asA(['send', base, 'one more thing', '--task', taskId, '--no-wait']);
  assert.notEqual(closed.code, 0);

  // Full conversation is visible to the owner.
  const g = await asA(['get', base, taskId]);
  assert.match(g.out, /\[you\] Hi, I need 4 tyres/);
  assert.match(g.out, /\[agent\] Base price is 2472 CZK/);
  assert.match(g.out, /\[you\] Friday 16 October please/);
});

test('another customer cannot read the task', async () => {
  const s = asA(['send', base, 'private request', '--no-wait']);
  const r = await s;
  const taskId = taskIdOf(r.out);
  const other = await asB(['get', base, taskId]);
  assert.notEqual(other.code, 0);
  assert.match(other.err, /not found/i);
  const item = itemIdOf((await biz(['read'])).out);
  await biz(['reply', item, 'ok', '--state', 'rejected']);
});

test('late reply after the executor stopped waiting is still delivered (stored path)', async () => {
  const r = await asA(['send', base, 'slow one', '--no-wait']);
  const taskId = taskIdOf(r.out);
  const item = itemIdOf((await biz(['read'])).out);
  await sleep(4500); // REPLY_WAIT_MS = 4000
  const rep = await biz(['reply', item, 'Sorry for the delay: 2472 CZK.', '--json']);
  assert.equal(JSON.parse(rep.out).delivered, 'stored');
  const w = await asA(['wait', base, taskId, '--timeout', '10']);
  assert.match(w.out, /state: TASK_STATE_INPUT_REQUIRED/);
  assert.match(w.out, /Sorry for the delay/);

  // The conversation continues normally after the stored path (no live bus for this task any more).
  const next = asA(['send', base, 'Fine, book it', '--task', taskId]);
  const item2 = itemIdOf((await biz(['wait', '--timeout', '20'])).out);
  await biz(['reply', item2, 'Booked.', '--state', 'completed']);
  const fin = await next;
  assert.equal(fin.code, 0, fin.err);
  assert.match(fin.out, /state: TASK_STATE_COMPLETED/);
});

test('push notification goes to an allowlisted webhook with the given bearer key', async () => {
  const r = await cli(A2A, ['send', base, 'notify me', '--push-url', `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/customer-hook`, '--push-key-env', 'HOOK'], {
    A2A_CREDENTIALS_FILE: join(tmp, 'cred-a.json'),
    HOOK: HOOK_KEY,
  });
  assert.equal(r.code, 0, r.err);
  const item = itemIdOf((await biz(['read'])).out);
  await biz(['reply', item, 'Here is your update.']);
  await sleep(500);
  const pushes = hookCalls.filter((c) => c.path === '/customer-hook');
  assert.ok(pushes.length > 0, 'no push received');
  assert.ok(pushes.every((p) => p.auth === `Bearer ${HOOK_KEY}`));
  assert.ok(pushes.some((p) => JSON.stringify(p.body).includes('Here is your update.')));

  const bad = await cli(A2A, ['send', base, 'x', '--push-url', 'https://evil.example/hook'], {
    A2A_CREDENTIALS_FILE: join(tmp, 'cred-a.json'),
  });
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /not allowed/);
});

test('turn limit fails the task after MAX_AGENT_TURNS business messages', async () => {
  let taskId = '';
  for (let turn = 1; turn <= 4; turn++) {
    const s = asA(taskId ? ['send', base, `turn ${turn}`, '--task', taskId] : ['send', base, `turn ${turn}`]);
    if (turn <= 3) {
      const item = itemIdOf((await biz(['wait', '--timeout', '20'])).out);
      await biz(['reply', item, `answer ${turn}`]);
    }
    const r = await s;
    taskId ||= taskIdOf(r.out);
    if (turn === 4) {
      assert.match(r.out, /state: TASK_STATE_FAILED/);
      assert.match(r.out, /Turn limit of 3/);
    }
  }
});

test('auth: roles are enforced on every surface', async () => {
  const post = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      method: path.startsWith('/a2a') ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: path.startsWith('/a2a') ? '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}' : undefined,
    }).then((r) => r.status);
  assert.equal(await post('/a2a/jsonrpc'), 401);
  assert.equal(await post('/a2a/jsonrpc', TOK.biz), 403);
  assert.equal(await post('/bot/inbox', TOK.a), 403);
  assert.equal(await post('/admin/events', TOK.a), 403);
  assert.equal(await post('/admin/events', TOK.admin), 200);
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 200);
});

test('enrollment: one-time code issues a working token without exposing it', async () => {
  const mk = async (role: string, id: string) => {
    const r = await fetch(`${base}/admin/enrollments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOK.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role, id, ttl_minutes: 5 }),
    });
    assert.equal(r.status, 200);
    return (await r.json()).redeem_url as string;
  };
  assert.equal((await fetch(`${base}/admin/enrollments`, { method: 'POST', headers: { authorization: `Bearer ${TOK.a}` } })).status, 403);

  const bizUrl = await mk('business', 'garage-demo');
  const cfgFile = join(tmp, 'enrolled-inbox.json');
  const env = { INBOX_CONFIG: cfgFile, RELAY_URL: '', RELAY_TOKEN: '' };
  const wrong = await cli(A2A, ['enroll', bizUrl], { A2A_CREDENTIALS_FILE: join(tmp, 'never.json') });
  assert.notEqual(wrong.code, 0, 'customer CLI must refuse a business code');
  // ...but that attempt burned the code, so issue a fresh one.
  const bizUrl2 = await mk('business', 'garage-demo');
  const ok = await cli(INBOX, ['enroll', bizUrl2], env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Enrolled as garage-demo \(business\)/);
  const saved = JSON.parse((await import('node:fs')).readFileSync(cfgFile, 'utf8'));
  assert.ok(!ok.out.includes(saved.token), 'token must not be printed');
  assert.equal((await import('node:fs')).statSync(cfgFile).mode & 0o777, 0o600);
  const again = await cli(INBOX, ['enroll', bizUrl2], env);
  assert.notEqual(again.code, 0, 'code is single-use');

  const read = await cli(INBOX, ['read'], env);
  assert.equal(read.code, 0, read.err);

  const custUrl = await mk('customer', 'customer-c');
  const credFile = join(tmp, 'cred-c.json');
  const c = await cli(A2A, ['enroll', custUrl], { A2A_CREDENTIALS_FILE: credFile });
  assert.equal(c.code, 0, c.err);
  const d = await cli(A2A, ['discover', base], { A2A_CREDENTIALS_FILE: credFile });
  assert.match(d.out, /credential: present/);
});

test('doorbell: business registers its own webhook; relay rings it with the key', async () => {
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/self-hook`;
  const bad = await biz(['set-doorbell', 'https://evil.example/hook', '--key', 'whatever-key-123']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /not allowed/);

  const before = hookCalls.length;
  const set = await biz(['set-doorbell', hookUrl, '--key', 'self-hook-key-123', '--test']);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /Test ring: HTTP 200/);
  assert.ok(!set.out.includes('self-hook-key-123'), 'key must not be echoed');
  const testRing = hookCalls.slice(before).find((c) => c.path === '/self-hook');
  assert.equal(testRing?.auth, 'Bearer self-hook-key-123');

  await sleep(3100); // past the ring debounce
  const n = hookCalls.length;
  const s = asA(['send', base, 'wake up shop', '--no-wait']);
  const taskId = taskIdOf((await s).out);
  await sleep(500);
  const rings = hookCalls.slice(n);
  assert.ok(rings.some((c) => c.path === '/self-hook' && c.body.event === 'work_pending'), 'registered doorbell not rung');
  assert.ok(!rings.some((c) => c.path === '/business-doorbell'), 'env webhook should be overridden');

  const item = itemIdOf((await biz(['read'])).out);
  await biz(['reply', item, 'awake', '--state', 'completed']);
  const events = await (await fetch(`${base}/admin/events?task=${taskId}`, { headers: { authorization: `Bearer ${TOK.admin}` } })).json();
  assert.ok(events.events.some((e: any) => e.kind === 'business_reply'));
  const all = JSON.stringify(await (await fetch(`${base}/admin/events`, { headers: { authorization: `Bearer ${TOK.admin}` } })).json());
  assert.ok(!all.includes('self-hook-key-123'), 'key must not be logged');

  assert.equal((await biz(['clear-doorbell'])).code, 0);
});
