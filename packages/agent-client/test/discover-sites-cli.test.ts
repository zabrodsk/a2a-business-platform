import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverSitesMain } from '../src/discover-sites-cli.js';

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
