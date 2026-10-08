import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { garageMain } from '../src/garage-cli.js';

const token = 'enrolled-business-token-0123456789';
const code = 'a'.repeat(43);
async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await run(); return output; } finally { process.stdout.write = original; }
}
async function fixture(run: (context: {
  config: string; origin: string; link: string; env: NodeJS.ProcessEnv;
  requests: Array<{ method: string; url: string; authorization: string | undefined }>;
  respond: (handler: (response: ServerResponse) => void) => void;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'garage-enrollment-'));
  const config = join(dir, 'private', 'garage.json');
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  let handler = (response: ServerResponse) => { response.end('{}'); };
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization });
    handler(res);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run({ config, origin, link: `${origin}/agent-enrollments/${code}`, env: { GARAGE_CONFIG: config }, requests,
      respond: next => { handler = next; } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('business enrollment saves private credentials and subsequent commands use them without printing secrets', async () => {
  await fixture(async ({ config, origin, link, env, requests, respond }) => {
    respond(response => { response.end(JSON.stringify({ role: 'business_agent', url: origin, token })); });
    const enrolled = await capture(() => garageMain(['enroll', link, '--allow-http-localhost'], env));
    assert.match(enrolled, /enrolled/);
    assert.ok(!enrolled.includes(token));
    assert.ok(!enrolled.includes(code));
    assert.deepEqual(requests[0], { method: 'POST', url: `/agent-enrollments/${code}`, authorization: undefined });
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { role: 'business_agent', url: origin, token });
    respond(response => { response.end(JSON.stringify({ repeated: token })); });
    const output = await capture(() => garageMain(['profile', '--allow-http-localhost'], env));
    assert.equal(output, '{"repeated":"[REDACTED]"}\n');
    assert.equal(requests.at(-1)!.authorization, `Bearer ${token}`);
    assert.equal(requests.at(-1)!.url, '/api/agent/profile');
    const count = requests.length;
    await assert.rejects(garageMain(['--url', 'https://other.example', 'profile', '--allow-http-localhost'], env), /TOKEN is required/);
    assert.equal(requests.length, count);
    const override = 'explicit-business-token-0123456789';
    await capture(() => garageMain(['profile', '--allow-http-localhost'], { ...env, PNEU007_BUSINESS_URL: origin, PNEU007_TOOL_TOKEN: override }));
    assert.equal(requests.at(-1)!.authorization, `Bearer ${override}`);
    // Re-enrollment replaces a pre-existing config without inheriting its broader file mode.
    writeFileSync(config, '{}', { mode: 0o644 });
    chmodSync(config, 0o644);
    respond(response => { response.end(JSON.stringify({ role: 'business_agent', url: origin, token })); });
    await capture(() => garageMain(['enroll', link, '--allow-http-localhost'], env));
    assert.equal(statSync(config).mode & 0o777, 0o600);
  });
});

test('enrollment validates HTTPS, URL shape, server origin, identity and token before saving', async () => {
  await fixture(async ({ config, origin, link, env, requests, respond }) => {
    for (const args of [
      ['enroll', link], ['enroll', `http://remote.example/agent-enrollments/${code}`, '--allow-http-localhost'],
      ['enroll', `${origin}/agent-enrollments/${code}?redirect=1`, '--allow-http-localhost'],
      ['enroll', `${origin}/agent-enrollments/${code}#fragment`, '--allow-http-localhost'],
      ['enroll', `${origin}/api/agent/profile`, '--allow-http-localhost'],
      ['enroll', `http://user:password@127.0.0.1/agent-enrollments/${code}`, '--allow-http-localhost'],
      ['enroll', link, 'extra', '--allow-http-localhost'],
      ['enroll', link, '--data-file', 'unused', '--allow-http-localhost'],
    ]) await assert.rejects(garageMain(args, env));
    assert.equal(requests.length, 0);
    for (const body of [
      { role: 'owner_agent', url: origin, token }, { role: 'business_agent', url: 'https://other.example', token },
      { role: 'business_agent', url: `${origin}/api`, token }, { role: 'business_agent', url: origin, token: `${token}\n` },
      { role: 'business_agent', url: origin, token: 'short' }, [], null,
    ]) {
      respond(response => { response.end(JSON.stringify(body)); });
      await assert.rejects(garageMain(['enroll', link, '--allow-http-localhost'], env), error => {
        assert.match(String(error), /Enrollment failed/);
        assert.ok(!String(error).includes(token));
        return true;
      });
      assert.equal(existsSync(config), false);
    }
  });
});

test('enrollment refuses redirects and hides server error bodies containing secrets', async () => {
  await fixture(async ({ config, origin, link, env, requests, respond }) => {
    respond(response => { response.statusCode = 302; response.setHeader('location', `${origin}/leak`); response.end(token); });
    await assert.rejects(garageMain(['enroll', link, '--allow-http-localhost'], env), /Enrollment failed/);
    assert.equal(requests.length, 1);
    assert.equal(existsSync(config), false);
    respond(response => { response.statusCode = 404; response.end(token); });
    await assert.rejects(garageMain(['enroll', link, '--allow-http-localhost'], env), error => {
      assert.ok(!String(error).includes(token));
      assert.ok(!String(error).includes(code));
      return true;
    });
    assert.equal(existsSync(config), false);
  });
});
