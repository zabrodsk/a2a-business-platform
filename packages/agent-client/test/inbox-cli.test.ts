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
