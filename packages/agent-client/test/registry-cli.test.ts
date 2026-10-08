import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, '../src/registry-cli.ts');
test('registry CLI separates public discovery from publisher credentials and confines writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-cli-'));
  const token = 'publisher-test-token-not-for-production';
  const requests: Array<{ path: string; method?: string; token?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url!, method: req.method, token: req.headers.authorization, body });
      if (req.url === '/api/businesses/redirect') { res.writeHead(302, { location: '/secret-destination' }).end(); return; }
      if (req.url === '/api/businesses/denied/pause') { res.writeHead(403).end(JSON.stringify({ error: `denied ${token}` })); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (args: string[], env: Record<string, string> = {}) => run(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, REGISTRY_URL: base, REGISTRY_TOKEN: token, ...env }, timeout: 5000 });
  const local = ['--allow-http-localhost'];
  try {
    assert.equal(JSON.parse((await call(['tools'], { REGISTRY_TOKEN: '' })).stdout).commands.length, 8);
    await call([...local, 'search', '--service', 'tyre_change&action=cancel', '--q', 'Holešovice&action=book', '--lat', '50.08', '--lon', '14.43', '--radius-km', '10']);
    assert.equal(requests[0]!.token, undefined);
    const query = new URL(requests[0]!.path, base).searchParams;
    assert.equal(query.get('service'), 'tyre_change&action=cancel'); assert.equal(query.get('action'), null); assert.equal(query.get('radius_km'), '10');
    assert.equal(query.get('q'), 'Holešovice&action=book');
    await call([...local, 'get', 'business-123']); assert.equal(requests[1]!.token, undefined);
    const file = join(dir, 'listing.json'); writeFileSync(file, JSON.stringify({ name: 'Demo garage' }));
    await call([...local, 'register', '--data-file', file]);
    assert.equal(requests[2]!.method, 'POST'); assert.equal(requests[2]!.token, `Bearer ${token}`); assert.equal(JSON.parse(requests[2]!.body).name, 'Demo garage');
    await call([...local, 'update', 'business-123', '--data-file', file]); assert.equal(requests[3]!.method, 'PATCH');
    const before = requests.length;
    for (const args of [['pause','../escape'], ['register'], ['search','--data-file',file], ['mine','--service','tyre_change'], ['mine','--q','Holešovice'], ['get','business-123','extra']]) await assert.rejects(call([...local, ...args]));
    await assert.rejects(call(['mine']), /HTTPS/);
    await assert.rejects(call([...local, 'mine'], { REGISTRY_TOKEN: '' }), /REGISTRY_TOKEN/);
    assert.equal(requests.length, before);
    await assert.rejects(call([...local, 'get', 'redirect'])); assert.ok(!requests.some(value => value.path === '/secret-destination'));
    await assert.rejects(call([...local, 'pause', 'denied']), error => {
      const text = (error as { stderr: string }).stderr; assert.ok(text.includes('[REDACTED]')); assert.ok(!text.includes(token)); return true;
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true });
  }
});
