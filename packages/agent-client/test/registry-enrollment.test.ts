import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile), cli = resolve(import.meta.dirname, '../src/registry-cli.ts');
const code = 'a'.repeat(43), token = `publisher_${'b'.repeat(43)}`;
test('registry enrollment stores a private credential, supports fallback and confines credentials to its registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-cli-enrollment-')), config = join(dir, 'nested', 'registry.json');
  const requests: Array<{ path: string; auth?: string }> = [];
  let base = '', reply: unknown;
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization });
    if (req.url === `/publisher-enrollments/${'c'.repeat(43)}`) { res.writeHead(302, { location: '/destination' }).end(); return; }
    if (req.url === `/publisher-enrollments/${'d'.repeat(43)}`) { res.writeHead(403).end(token + code); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url!.startsWith('/publisher-enrollments/') ? reply : { echoed: req.headers.authorization, secret: token }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  reply = { role: 'publisher', registry_url: base, token };
  const call = (args: string[], env: Record<string, string> = {}) => run(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, REGISTRY_CONFIG: config, REGISTRY_URL: '', REGISTRY_TOKEN: '', ...env }, timeout: 5000 });
  // Undefined env variables rather than empty ones select the saved credential.
  const savedCall = (args: string[], env: Record<string, string> = {}) => {
    const childEnv = { ...process.env, REGISTRY_CONFIG: config }; delete childEnv.REGISTRY_URL; delete childEnv.REGISTRY_TOKEN; Object.assign(childEnv, env);
    return run(process.execPath, ['--import', 'tsx', cli, ...args], { env: childEnv, timeout: 5000 });
  };
  const local = ['--allow-http-localhost'];
  try {
    await assert.rejects(call(['enroll', `${base}/publisher-enrollments/${code}`]), /HTTPS/);
    const enrolled = await call([...local, 'enroll', `${base}/publisher-enrollments/${code}`]);
    assert.ok(!enrolled.stdout.includes(token)); assert.ok(!enrolled.stdout.includes(code));
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { registry_url: base, token });
    assert.equal(requests[0]!.auth, undefined);
    const mine = await savedCall([...local, 'mine']);
    assert.equal(requests.at(-1)!.auth, `Bearer ${token}`); assert.ok(!mine.stdout.includes(token)); assert.ok(mine.stdout.includes('[REDACTED]'));
    await savedCall([...local, 'search']); assert.equal(requests.at(-1)!.auth, undefined);
    await savedCall([...local, 'mine'], { REGISTRY_TOKEN: 'override-token' }); assert.equal(requests.at(-1)!.auth, 'Bearer override-token');
    const before = requests.length;
    await assert.rejects(savedCall(['--url', 'https://other.example', 'mine']), /another registry/); assert.equal(requests.length, before);
    writeFileSync(config, '{invalid');
    await call([...local, 'mine'], { REGISTRY_URL: base, REGISTRY_TOKEN: 'override-token' });
    await savedCall([...local, '--url', base, 'mine'], { REGISTRY_TOKEN: 'explicit-url-token' });
    assert.equal(requests.at(-1)!.auth, 'Bearer explicit-url-token');
    await assert.rejects(savedCall([...local, 'mine']), /credential configuration/);
    for (const bad of [{ role: 'admin', registry_url: base, token }, { role: 'publisher', registry_url: 'https://other.example', token }, { role: 'publisher', registry_url: base, token: 'invalid' }]) {
      reply = bad;
      await assert.rejects(call([...local, 'enroll', `${base}/publisher-enrollments/${code}`]), error => {
        const stderr = (error as { stderr: string }).stderr; assert.match(stderr, /enrollment failed/); assert.ok(!stderr.includes(token)); assert.ok(!stderr.includes(code)); return true;
      });
    }
    for (const secretCode of ['c'.repeat(43), 'd'.repeat(43)]) await assert.rejects(call([...local, 'enroll', `${base}/publisher-enrollments/${secretCode}`]), error => {
      const stderr = (error as { stderr: string }).stderr; assert.ok(!stderr.includes(token)); assert.ok(!stderr.includes(secretCode)); return true;
    });
    assert.ok(!requests.some(request => request.path === '/destination'));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
});
