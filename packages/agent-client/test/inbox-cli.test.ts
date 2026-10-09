import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxMain } from '../src/inbox-cli.js';

const token = 'private-business-token-0123456789';
const url = 'https://garage.example';
async function fixture(run: (garage: string, inbox: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
  const garage = join(dir, 'garage.json'), inbox = join(dir, 'inbox.json');
  const names = ['GARAGE_CONFIG', 'INBOX_CONFIG', 'RELAY_URL', 'RELAY_TOKEN'] as const;
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch, oldLog = console.log;
  process.env.GARAGE_CONFIG = garage; process.env.INBOX_CONFIG = inbox;
  delete process.env.RELAY_URL; delete process.env.RELAY_TOKEN;
  writeFileSync(garage, JSON.stringify({ role: 'business_agent', url, token }));
  try { await run(garage, inbox); }
  finally {
    globalThis.fetch = oldFetch; console.log = oldLog;
    for (const name of names) { if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name]; }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('use-garage imports locally with private atomic replacement and no credential output', async () => {
  await fixture(async (garage, inbox) => {
    globalThis.fetch = async () => { throw new Error('Import must not use the network'); };
    const logs: string[] = []; console.log = (...values) => { logs.push(values.join(' ')); };
    await inboxMain(['use-garage']);
    assert.deepEqual(JSON.parse(readFileSync(inbox, 'utf8')), { url, token });
    assert.equal(statSync(inbox).mode & 0o777, 0o600);
    const updatedToken = token + '-replacement';
    writeFileSync(garage, JSON.stringify({ role: 'business_agent', url: url + '/', token: updatedToken }));
    await inboxMain(['use-garage']);
    assert.equal(JSON.parse(readFileSync(inbox, 'utf8')).token, updatedToken);
    assert.equal(statSync(inbox).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(inbox, '..')).filter(name => name.endsWith('.tmp')).length, 0);
    assert.ok(!logs.join('\n').includes(token));
  });
});

test('use-garage preserves another origin and rejects invalid source without exposing credentials', async () => {
  await fixture(async (garage, inbox) => {
    const previous = JSON.stringify({ url: 'https://polar.example', token });
    writeFileSync(inbox, previous);
    await assert.rejects(inboxMain(['use-garage']), /another INBOX_CONFIG/);
    assert.equal(readFileSync(inbox, 'utf8'), previous);
    rmSync(inbox);
    for (const value of [
      { role: 'customer_agent', url, token }, { role: 'business_agent', url: 'http://localhost', token },
      ...['https://user:password@garage.example', url + '/api', url + '?x=1', url + '#x', url + '?', url + '#', url + '/a/..', 'invalid'].map(url => ({ role: 'business_agent', url, token })),
      ...['short', token + '\n', token + ' ', token + '\u0000', token + '"'].map(token => ({ role: 'business_agent', url, token })), null, [],
    ]) {
      writeFileSync(garage, JSON.stringify(value));
      await assert.rejects(inboxMain(['use-garage']), error => { assert.ok(!String(error).includes(token)); return true; });
    }
    writeFileSync(garage, '{' + token);
    await assert.rejects(inboxMain(['use-garage']), /Cannot read private configuration/);
    await assert.rejects(inboxMain(['use-garage', 'unexpected']), /usage/);
  });
});

test('inbox requests pin credentials to configured origin, refuse redirects and bound long polls', async () => {
  await fixture(async (_garage, inbox) => {
    writeFileSync(inbox, JSON.stringify({ url, token }));
    process.env.RELAY_URL = ''; process.env.RELAY_TOKEN = '';
    console.log = () => {};
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), url + '/bot/wait?timeout=55');
      assert.equal(init!.redirect, 'error');
      assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer ' + token);
      signal = init!.signal!;
      return new Response('{"items":[]}');
    };
    await inboxMain(['wait', '--timeout', '55']);
    assert.ok(signal instanceof AbortSignal);
    for (const value of ['0', '56', 'NaN', 'Infinity', '-1']) await assert.rejects(inboxMain(['wait', '--timeout', value]), /timeout/);
    process.env.RELAY_URL = 'https://other.example';
    await assert.rejects(inboxMain(['read']), /another INBOX_CONFIG/);
  });
});

test('inbox transport errors and successful echoed credentials are sanitized', async () => {
  await fixture(async (_garage, inbox) => {
    writeFileSync(inbox, JSON.stringify({ url, token }));
    const logs: string[] = []; console.log = (...values) => { logs.push(values.join(' ')); };
    globalThis.fetch = async () => new Response(JSON.stringify({ task_id: token, state: 'completed' }));
    await inboxMain(['reply', 'work-id', 'answer', '--json']);
    assert.ok(!logs.join('\n').includes(token));
    assert.match(logs.join('\n'), /REDACTED/);
    globalThis.fetch = async () => new Response(token, { status: 401 });
    await assert.rejects(inboxMain(['read']), error => { assert.match(String(error), /HTTP 401/); assert.ok(!String(error).includes(token)); return true; });
    const key = 'private-webhook-key-123';
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'host not allowed ' + token + key }), { status: 400 });
    await assert.rejects(inboxMain(['set-doorbell', 'https://evil.example/hook', '--key', key]), error => {
      assert.match(String(error), /Webhook host not allowed/);
      assert.ok(!String(error).includes(token)); assert.ok(!String(error).includes(key)); return true;
    });
    globalThis.fetch = async () => { throw new Error('redirected secret: ' + token); };
    await assert.rejects(inboxMain(['read']), error => { assert.match(String(error), /failed or timed out/); assert.ok(!String(error).includes(token)); return true; });
  });
});

const hookKey = 'private-hook-bearer-key-123';
const hookUrl = 'https://api2.cursor.sh/hooks/native?private_query=value';
const probeToken = 'native-webhook-probe-token-0123456789';
async function wakeupFixture(run: (context: {
  dir: string; privateFile: (name: string, value: unknown) => string;
  requests: Array<{ path: string; method: string; body: unknown }>;
  respond: (handler: (path: string, method: string, body: unknown) => Response) => void;
  logs: string[];
}) => Promise<void>) {
  await fixture(async (_garage, inbox) => {
    writeFileSync(inbox, JSON.stringify({ url, token }));
    const dir = join(inbox, '..');
    const requests: Array<{ path: string; method: string; body: unknown }> = [], logs: string[] = [];
    console.log = (...values) => { logs.push(values.join(' ')); };
    let handler = () => new Response('{}');
    globalThis.fetch = async (input, init) => {
      assert.equal(init!.redirect, 'error');
      assert.ok(init!.signal instanceof AbortSignal);
      assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer ' + token);
      const target = new URL(String(input)); assert.equal(target.origin, url);
      const path = target.pathname, method = init!.method ?? 'GET';
      const body = typeof init!.body === 'string' ? JSON.parse(init!.body) : undefined;
      requests.push({ path, method, body });
      return handler(path, method, body);
    };
    await run({ dir, requests, logs,
      privateFile: (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; },
      respond: next => { handler = next; },
    });
  });
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const unconfigured = { configured: false, ready: false, verification_state: 'unconfigured' };
const fingerprint = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ url: new URL(hookUrl).toString(), key: hookKey })).digest('hex');
const pending = { configured: true, ready: false, verification_state: 'pending', webhook_fingerprint: fingerprint,
  host: 'api2.cursor.sh', expires_at: '2099-01-01T00:00:00.000Z' };
const verified = { ...pending, ready: true, verification_state: 'verified', verified_at: '2026-10-09T12:00:00.000Z' };

test('setup-wakeup returns pending after HTTP 200, yields without polling and never prints callback secrets', async () => {
  await wakeupFixture(async ({ privateFile, requests, respond, logs }) => {
    const file = privateFile('native-hook.json', { url: hookUrl, key: hookKey });
    respond((_path, method) => method === 'POST'
      ? jsonResponse({ ok: true, test_ring: { status: 200 }, url: hookUrl, key: hookKey })
      : jsonResponse(requests.length === 1 ? unconfigured : { ...pending, url: hookUrl, key: hookKey, setup_probe: { token: probeToken } }));
    await inboxMain(['setup-wakeup', '--config-file', file]);
    assert.deepEqual(requests.map(value => [value.path, value.method]), [
      ['/bot/doorbell', 'GET'], ['/bot/doorbell', 'POST'], ['/bot/doorbell', 'GET'],
    ]);
    assert.deepEqual(requests[1]!.body, { url: new URL(hookUrl).toString(), key: hookKey, test: true });
    const result = JSON.parse(logs.join(''));
    assert.equal(result.ready, false); assert.equal(result.verification_state, 'pending');
    assert.equal(result.next_action, 'yield_to_native_routine'); assert.match(result.instruction, /End this setup turn/);
    for (const secret of [token, hookKey, hookUrl, 'private_query', probeToken]) assert.ok(!logs.join('').includes(secret));
  });
});

test('setup-wakeup is idempotent for the same verified callback; wakeup-status only reads safe status', async () => {
  await wakeupFixture(async ({ privateFile, requests, respond, logs }) => {
    const file = privateFile('native-hook.json', { url: hookUrl, key: hookKey });
    respond(() => jsonResponse({ ...verified, arbitrary: hookKey }));
    await inboxMain(['setup-wakeup', '--config-file', file]);
    assert.equal(requests.length, 1); assert.equal(requests[0]!.method, 'GET');
    assert.equal(JSON.parse(logs[0]!).outcome, 'already_verified');
    logs.length = 0;
    await inboxMain(['wakeup-status']);
    assert.equal(requests.length, 2); assert.equal(JSON.parse(logs[0]!).ready, true);
    assert.ok(!logs.join('').includes(hookKey));
  });
});

test('native acknowledge uses only the actual event nonce and handles duplicate acknowledgments honestly', async () => {
  await wakeupFixture(async ({ privateFile, requests, respond, logs }) => {
    const file = privateFile('native-event.json', { event: 'work_pending', setup_probe: { token: probeToken, expires_at: pending.expires_at } });
    respond(() => jsonResponse(verified));
    await inboxMain(['acknowledge-wakeup', '--event-file', file]);
    assert.deepEqual(requests[0], { path: '/bot/doorbell/ack', method: 'POST', body: { probe_token: probeToken } });
    assert.equal(requests[1]!.path, '/bot/doorbell');
    assert.equal(JSON.parse(logs[0]!).outcome, 'native_probe_acknowledged');
    assert.ok(!logs.join('').includes(probeToken));
    logs.length = 0;
    respond((path) => path.endsWith('/ack') ? jsonResponse({ error: 'invalid or expired setup probe ' + probeToken }, 400) : jsonResponse(verified));
    await inboxMain(['acknowledge-wakeup', '--event-file', file]);
    assert.equal(JSON.parse(logs[0]!).outcome, 'already_verified');
    assert.ok(!logs.join('').includes(probeToken));
  });
});

test('wakeup commands reject malformed, oversized, nonprivate and nonregular files before networking', async () => {
  await wakeupFixture(async ({ dir, privateFile, requests }) => {
    for (const value of [null, [], { url: hookUrl }, { url: hookUrl, key: hookKey, other: 'unexpected' },
      ...['http://api2.cursor.sh/hook', 'https://user:password@api2.cursor.sh/hook', hookUrl + '#fragment', hookUrl + '#'].map(url => ({ url, key: hookKey })),
      { url: hookUrl, key: 'short' }, { url: hookUrl, key: hookKey + '\n' }]) {
      await assert.rejects(inboxMain(['setup-wakeup', '--config-file', privateFile('bad-hook.json', value)]));
    }
    for (const value of [{}, { setup_probe: {} }, { setup_probe: { token: 'short' } }, { probe_token: probeToken }]) {
      await assert.rejects(inboxMain(['acknowledge-wakeup', '--event-file', privateFile('bad-event.json', value)]), /no valid setup_probe/);
    }
    const oversized = privateFile('too-large.json', { value: 'a'.repeat(16_384) });
    await assert.rejects(inboxMain(['setup-wakeup', '--config-file', oversized]), /16 KiB/);
    const malformed = privateFile('malformed.json', {}); writeFileSync(malformed, '{' + hookKey);
    await assert.rejects(inboxMain(['setup-wakeup', '--config-file', malformed]), error => { assert.ok(!String(error).includes(hookKey)); return true; });
    const publicFile = join(dir, 'public.json'); writeFileSync(publicFile, JSON.stringify({ url: hookUrl, key: hookKey }), { mode: 0o644 });
    await assert.rejects(inboxMain(['setup-wakeup', '--config-file', publicFile]), /private regular file/);
    await assert.rejects(inboxMain(['setup-wakeup', '--config-file', dir]), /private regular file/);
    await assert.rejects(inboxMain(['wakeup-status', '--event-file', malformed]), /usage/);
    assert.equal(requests.length, 0);
  });
});

test('wakeup readiness cannot come from malformed status, expired proof, wrong callback or rejected nonce', async () => {
  await wakeupFixture(async ({ privateFile, requests, respond, logs }) => {
    const callback = privateFile('native-hook.json', { url: hookUrl, key: hookKey });
    for (const status of [{}, { ...verified, verification_state: 'pending' }, { ...verified, webhook_fingerprint: 'bad' }]) {
      respond(() => jsonResponse(status));
      await assert.rejects(inboxMain(['wakeup-status']), /Invalid wake-up status/);
    }
    respond(() => jsonResponse({ ...verified, expires_at: '2000-01-01T00:00:00.000Z' }));
    await inboxMain(['wakeup-status']);
    assert.equal(JSON.parse(logs.at(-1)!).ready, false); assert.equal(JSON.parse(logs.at(-1)!).verification_state, 'expired');
    let seen = 0;
    respond(() => jsonResponse(++seen === 1 ? unconfigured : { ...pending, webhook_fingerprint: 'a'.repeat(64) }));
    await assert.rejects(inboxMain(['setup-wakeup', '--config-file', callback]), /changed during setup/);
    const event = privateFile('native-event.json', { setup_probe: { token: probeToken } });
    respond(path => path.endsWith('/ack') ? jsonResponse({ error: probeToken }, 400) : jsonResponse(pending));
    await assert.rejects(inboxMain(['acknowledge-wakeup', '--event-file', event]), error => {
      assert.ok(!String(error).includes(probeToken)); assert.match(String(error), /not verified/); return true;
    });
    const before = requests.length;
    respond(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/?' + hookKey } }));
    await assert.rejects(inboxMain(['wakeup-status']), /HTTP 302/);
    assert.equal(requests.length, before + 1);
  });
});

test('managed inbox claims keep lease credentials for subsequent replies alongside wake-up commands', async () => {
  await fixture(async (_garage, inbox) => {
    writeFileSync(inbox, JSON.stringify({ url, token }));
    console.log = () => {};
    const leaseToken = 'managed-private-lease-token-0123456789';
    let reply: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/bot/inbox') return jsonResponse({ items: [{
        work_item_id: 'managed-work-item', task_id: 'managed-task', customer: 'customer-agent', turn: 1, max_turns: 10,
        business_id: 'managed-business', connection_id: 'managed-connection', execution_epoch: 2,
        lease_token: leaseToken, claim_generation: 3, lease_until: Date.now() + 60_000, history: [],
      }] });
      assert.equal(path, '/bot/reply');
      reply = JSON.parse(String(init!.body));
      return jsonResponse({ task_id: 'managed-task', state: 'input-required' });
    };
    await inboxMain(['read']);
    assert.equal(statSync(inbox + '.leases.json').mode & 0o777, 0o600);
    await inboxMain(['reply', 'managed-work-item', 'Quote is ready']);
    assert.equal(reply!.lease_token, leaseToken); assert.equal(reply!.claim_generation, 3);
    await inboxMain(['reply', 'managed-work-item', 'Quote is ready', '--lease-token', leaseToken + '-fresh', '--claim-generation', '4']);
    assert.equal(reply!.lease_token, leaseToken + '-fresh'); assert.equal(reply!.claim_generation, 4);
  });
});


test('repeated setup preserves a matching pending probe and its expiry without registering again', async () => {
  await wakeupFixture(async ({ privateFile, requests, respond, logs }) => {
    const file = privateFile('native-hook.json', { url: hookUrl, key: hookKey });
    respond(() => jsonResponse(pending));
    await inboxMain(['setup-wakeup', '--config-file', file]);
    assert.deepEqual(requests.map(value => [value.path, value.method]), [['/bot/doorbell', 'GET']]);
    const status = JSON.parse(logs[0]!);
    assert.equal(status.ready, false);
    assert.equal(status.verification_state, 'pending');
    assert.equal(status.expires_at, pending.expires_at);
    assert.equal(status.next_action, 'yield_to_native_routine');
    assert.equal(status.outcome, 'awaiting_native_acknowledgment');
  });
});

test('wake-up setup follows the assigned managed relay base and never borrows another relay credential', async () => {
  await fixture(async (_garage, inbox) => {
    const managed = url + '/relay/relay_demo';
    writeFileSync(inbox, JSON.stringify({ url: managed, token }));
    console.log = () => {};
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), managed + '/bot/doorbell');
      assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer ' + token);
      return Response.json({ configured: false, ready: false, verification_state: 'unconfigured' });
    };
    await inboxMain(['wakeup-status']);
    process.env.RELAY_URL = url + '/relay/another_business';
    await assert.rejects(inboxMain(['wakeup-status']), /another INBOX_CONFIG/);
    delete process.env.RELAY_URL;
    for (const invalid of ['/relay/../other', '/relay/id/bot', '/relay/id?token=private', '/relay/id#fragment', '/relay/%2e%2e']) {
      writeFileSync(inbox, JSON.stringify({ url: url + invalid, token }));
      await assert.rejects(inboxMain(['wakeup-status']), /Invalid private inbox configuration/);
    }
  });
});

test('scheduled inbox tools use the existing private enrollment without asking for webhook credentials', async () => {
  await fixture(async (_garage, inbox) => {
    writeFileSync(inbox, JSON.stringify({ url, token }));
    const requests: {path:string;method:string;body:unknown}[] = [], logs:string[] = [];
    console.log = (...values) => logs.push(values.join(' '));
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input));
      assert.equal(target.origin, url);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + token);
      assert.equal(init?.redirect, 'error');
      requests.push({ path: target.pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ mode:'scheduled', available:false, runtime_schedule_verified:false, user_message:'I’m testing automatic inbox checks.' }));
    };
    await inboxMain(['scheduled-check-in']);
    await inboxMain(['availability']);
    assert.deepEqual(requests, [{path:'/bot/scheduled-check-in',method:'POST',body:{interval_seconds:60}},{path:'/bot/availability',method:'GET',body:undefined}]);
    assert.ok(!logs.join('\n').includes(token));
    for (const interval of ['59','301','NaN','60.5']) await assert.rejects(inboxMain(['scheduled-check-in','--interval',interval]), /60..300/);
    assert.equal(requests.length, 2);
  });
});
