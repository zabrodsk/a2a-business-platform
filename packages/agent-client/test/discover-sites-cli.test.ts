import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { discoverSitesMain } from '../src/discover-sites-cli.js';
import { discoverWebsites } from '../src/website-discovery.js';

test('downloaded CLI invoked through a symlink executes and writes its report', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-symlink-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, 'discover-sites.mjs'), alias = join(dir, 'scan.mjs');
  const file = join(dir, 'sites.json'), output = join(dir, 'report.json');
  await build({ entryPoints: [fileURLToPath(new URL('../src/discover-sites-cli.ts', import.meta.url))], outfile: cli,
    bundle: true, platform: 'node', format: 'esm', target: 'node18', logLevel: 'silent' });
  symlinkSync(cli, alias);
  writeFileSync(file, '[]');
  const stdout = execFileSync(process.execPath, [alias, '--sites-file', file, '--output', output], { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  assert.equal(report.coverage.scanned, 0);
  assert.equal(report.coverage.incomplete, false);
  assert.equal(readFileSync(output, 'utf8'), stdout);
});

test('CLI reads browser candidates and writes structured report with annotated filters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-sites-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json'), output = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify([{ name: 'Garage', website: 'https://garage.example.com' }]));
  let stdout = '';
  const result = await discoverSitesMain(['--sites-file', file, '--output', output, '--service', 'tyre_change', '--area', 'Prague 6'], {
    stdout: text => { stdout += text; }, fetchDocument: async url => ({ url, status: 404, headers: {}, body: '' }),
  });
  assert.equal(result?.candidates[0].status, 'not_found');
  assert.deepEqual(JSON.parse(stdout).request, { service: 'tyre_change', area: 'Prague 6' });
  assert.equal(readFileSync(output, 'utf8'), stdout);
});
test('CLI help explains browser search and public-only boundary', async () => {
  let stdout = ''; await discoverSitesMain(['--help'], { stdout: text => { stdout += text; } });
  assert.match(stdout, /browser/); assert.match(stdout, /does not search Maps/);
});
test('CLI refuses invalid JSON, oversized files, unknown fields and invalid limits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-sites-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json');
  for (const body of ['secret invalid json', ' '.repeat(32769), JSON.stringify([{ name: 'Garage', website: 'https://garage.example.com', token: 'secret' }])]) {
    writeFileSync(file, body);
    await assert.rejects(discoverSitesMain(['--sites-file', file], { stdout: () => {} }));
  }
  for (const args of [[], ['--sites-file', file, '--limit', '21'], ['--sites-file', file, '--limit', '1.5'], ['--sites-file', file, '--token', 'secret']]) {
    await assert.rejects(discoverSitesMain(args));
  }
});

test('hosted mode sends only public candidates to the operator origin and labels execution', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-hosted-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json'), candidates = [{ name: 'Garage', website: 'https://garage.example.com' }];
  writeFileSync(file, JSON.stringify(candidates));
  const result = await discoverSitesMain(['--sites-file', file, '--via', 'https://platform.example.com', '--service', 'tyre_change'], {
    stdout: () => {}, fetchDocument: async () => { throw new Error('Direct DNS fetch must not run'); },
    hostedFetch: async (url, init) => {
      assert.equal(url, 'https://platform.example.com/discovery/websites');
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
      assert.deepEqual(init?.headers, { accept: 'application/json', 'content-type': 'application/json' });
      assert.deepEqual(JSON.parse(String(init?.body)), { candidates, service: 'tyre_change', limit: 10 });
      return Response.json({ request: { service: 'tyre_change' }, coverage: { submitted: 1, unique: 1, scanned: 1, truncated: false, incomplete: true }, candidates: [{ ...candidates[0], status: 'blocked', incomplete: true }] });
    },
  });
  assert.deepEqual(result && 'execution' in result ? result.execution : undefined, { mode: 'hosted', origin: 'https://platform.example.com' });
  assert.equal(result?.coverage.incomplete, true);
});

test('hosted mode rejects unsafe origins and excess candidates before fetching', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-hosted-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json'); writeFileSync(file, JSON.stringify([{ name: 'Garage', website: 'https://garage.example.com' }]));
  const dependencies = { stdout: () => {}, hostedFetch: async () => { throw new Error('Must not fetch'); } };
  for (const origin of ['http://platform.example.com', 'https://127.0.0.1', 'https://198.18.0.1', 'https://user:secret@platform.example.com', 'https://platform.example.com/path', 'https://platform.example.com?secret=value']) {
    await assert.rejects(discoverSitesMain(['--sites-file', file, '--via', origin], dependencies), error => !String(error).includes('Must not fetch'));
  }
  await assert.rejects(discoverSitesMain(['--sites-file', file, '--via', 'https://platform.example.com', '--limit', '11'], dependencies), /at most 10/);
  writeFileSync(file, JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ name: `Garage ${i}`, website: `https://garage${i}.example.com` }))));
  await assert.rejects(discoverSitesMain(['--sites-file', file, '--via', 'https://platform.example.com'], dependencies), /at most 10/);
});

test('hosted errors, oversized streams and malformed reports are bounded and sanitized', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-hosted-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json'); writeFileSync(file, JSON.stringify([{ name: 'Garage', website: 'https://garage.example.com' }]));
  const responses = [
    new Response('private error body', { status: 429 }),
    new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '4194305' } }),
    new Response('x'.repeat(4194305), { headers: { 'content-type': 'application/json' } }),
    Response.json({ token: 'private error body' }),
  ];
  for (const response of responses) await assert.rejects(discoverSitesMain(['--sites-file', file, '--via', 'https://platform.example.com'], {
    stdout: () => {}, hostedFetch: async () => response,
  }), error => !String(error).includes('private error body'));
});

test('hosted CLI accepts ten large valid cards within protected upstream limits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-large-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sites.json');
  const candidates = Array.from({ length: 10 }, (_, i) => ({ name: `Garage ${i}`, website: `https://garage${i}.example.com` }));
  writeFileSync(file, JSON.stringify(candidates));
  const card = {
    name: 'Garage', description: 'Public business', skills: [{ id: 'quote', name: 'Quote', description: 'Tyre service', tags: ['tyres'] }],
    supportedInterfaces: [{ url: 'https://garage.example.com/a2a/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    securitySchemes: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`scheme${i}`, { description: 'a'.repeat(2000), bearerFormat: 'b'.repeat(2000), type: 'c'.repeat(2000) }])),
  };
  const body = JSON.stringify(card); assert.ok(Buffer.byteLength(body) < 256 * 1024);
  const report = await discoverWebsites(candidates, { fetchDocument: async url => ({ url, status: 200, headers: { 'content-type': 'application/json' }, body }) });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 2 * 1024 * 1024);
  const result = await discoverSitesMain(['--sites-file', file, '--via', 'https://platform.example.com'], {
    stdout: () => {}, hostedFetch: async () => Response.json(report),
  });
  assert.equal(result?.coverage.scanned, 10);
  assert.ok(result?.candidates.every(candidate => candidate.status === 'compatible'));
});
