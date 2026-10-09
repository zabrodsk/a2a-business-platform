import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
const run = promisify(execFile);
for (const name of ['handle', 'handoru']) test(`${name} CLI stores issued credentials privately, binds their URL, and never prints bearer values`, async () => {
  const cli = resolve(import.meta.dirname, `../dist/${name}.mjs`);
  const issued = 'private-issued-handoru-test-token';
  const requests: Array<{url?:string;authorization?:string;key?:string}> = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, key: req.headers['idempotency-key'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/handle.json') return res.end('{"version":"1.0","fictional_demo":true}');
    if (req.url === '/api/handle/v1/agent-registrations') return res.end(JSON.stringify({
      request_id: 'test-request', provisional_credential: issued, user_code: '123456', message: `received ${issued}`,
    }));
    res.end(JSON.stringify({ ok: true, reflected: req.headers.authorization, token: issued }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'handoru-cli-test-'));
  const tokenFile = join(dir, 'credential.json'), bodyFile = join(dir, 'request.json');
  writeFileSync(bodyFile, '{"runtime":"scripted CLI fixture","legacy_url":"https://example.test"}');
  const env = {
    ...process.env, HANDLE_TOKEN: '', HANDLE_TOKEN_FILE: '', HANDLE_URL: url, HANDORU_TOKEN: '', HANDORU_TOKEN_FILE: '', HANDORU_URL: '',
    ...(name === 'handoru' ? { HANDLE_URL: undefined, HANDLE_TOKEN: undefined, HANDLE_TOKEN_FILE: undefined, HANDORU_URL: url } : {}),
  };
  const exec = (args: string[]) => run(process.execPath, [cli, ...args], { env });
  try {
    const bootstrap = await exec(['bootstrap']);
    assert.equal(JSON.parse(bootstrap.stdout).fictional_demo, true);
    await assert.rejects(exec(['request', 'POST', '/api/handle/v1/agent-registrations', '--body-file', bodyFile]), /--save-token/);
    assert.equal(requests.length, 1, 'credential-issuing request must not be sent without storage destination');
    await assert.rejects(exec(['request', 'POST', '/api/handle/v1/businesses/business-test/connections/connection-test/credentials/rotate']), /--save-token/);
    assert.equal(requests.length, 1, 'rotation must not revoke the old credential before a save destination is supplied');
    const registration = await exec(['request', 'POST', '/api/handle/v1/agent-registrations', '--body-file', bodyFile, '--save-token', tokenFile]);
    assert.ok(!registration.stdout.includes(issued));
    assert.equal(JSON.parse(registration.stdout).user_code, '123456');
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(tokenFile, 'utf8')).token, issued);
    const call = await exec(['request', 'GET', '/api/handle/v1/me', '--token-file', tokenFile, '--idempotency-key', 'stable-key']);
    assert.ok(!call.stdout.includes(issued));
    assert.equal(requests.at(-1)?.authorization, `Bearer ${issued}`);
    assert.equal(requests.at(-1)?.key, 'stable-key');
    const byEnvironment = await run(process.execPath, [cli, 'request', 'GET', '/api/handle/v1/me'], {
      env: { ...env, [`${name.toUpperCase()}_TOKEN_FILE`]: tokenFile },
    });
    assert.ok(!byEnvironment.stdout.includes(issued));
    assert.equal(requests.at(-1)?.authorization, `Bearer ${issued}`);
    assert.ok(requests.every((req) => !req.url?.includes(issued)));
    await assert.rejects(exec(['request', 'GET', '/api/handle/v1/me', '--url', 'http://127.0.0.1:1', '--token-file', tokenFile]), /another Handle URL/);
    await assert.rejects(exec(['request', 'GET', '/api/me?token=secret']), /not allowed/);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
