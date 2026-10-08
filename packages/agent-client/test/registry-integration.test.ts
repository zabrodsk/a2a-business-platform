import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRegistry } from '../../../apps/registry/src/server.js';

const run = promisify(execFile);
test('bundled publisher registers, verifies, is discovered by customer, updates and pauses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-agent-e2e-'));
  const documents = new Map<string, unknown>();
  const registry = createRegistry({ dbPath: join(dir, 'registry.sqlite'), port: 8792, host: '127.0.0.1', adminToken: 'registry-admin-test-only-0123456789' }, {
    startHealthTimer: false, fetchJson: async url => { if (!documents.has(url)) throw new Error('Not published'); return documents.get(url); },
  });
  const server = registry.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let token = '';
  const cli = async (args: string[], customer = false) => {
    const output = await run(process.execPath, [resolve(import.meta.dirname, '../dist/registry.mjs'), '--allow-http-localhost', ...args], { env: { ...process.env, REGISTRY_URL: base, REGISTRY_TOKEN: customer ? '' : token }, timeout: 10000 });
    return JSON.parse(output.stdout);
  };
  try {
    const issued = await fetch(base + '/api/publishers', { method: 'POST', headers: { authorization: 'Bearer registry-admin-test-only-0123456789', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Demo garage operator' }) });
    assert.equal(issued.status, 201); token = (await issued.json()).token;
    const listing = { name: 'Fictional demo garage', description: 'Sandbox tire change and wheel swap booking.', website: 'https://garage.example.com',
      agent_card_url: 'https://garage.example.com/.well-known/agent-card.json', services: ['tyre_change','wheel_swap'], actions: ['information','quote','book'],
      location: { latitude: 50.08, longitude: 14.43, address: 'Fictional test location, Prague' } };
    const file = join(dir, 'business.json'); writeFileSync(file, JSON.stringify(listing));
    const registered = await cli(['register', '--data-file', file]);
    assert.equal(registered.status, 'pending');
    assert.equal((await cli(['register','--data-file',file])).business_id, registered.business_id);
    assert.equal((await cli(['search','--service','tyre_change'], true)).businesses.length, 0);
    // Simulate authorized website publication; no external website is changed by this test.
    documents.set(registered.verification.url, registered.verification.body);
    documents.set(listing.agent_card_url, { name: 'Demo service agent', skills: [{ id: 'tyre-service-negotiation', name: 'Quote and book', description: 'Demo', tags: ['booking'] }],
      supportedInterfaces: [{ url: 'https://garage.example.com/a2a/jsonrpc', protocolVersion: '1.0', protocolBinding: 'JSONRPC' }] });
    assert.equal((await cli(['verify',registered.business_id])).status, 'active');
    const discovered = await cli(['search','--service','tyre_change','--action','book','--lat','50.08','--lon','14.43','--radius-km','10'], true);
    assert.equal(discovered.businesses[0].business_id, registered.business_id);
    assert.equal(discovered.businesses[0].agent_card_url, listing.agent_card_url);
    assert.equal(discovered.businesses[0].verification, undefined);
    assert.equal(discovered.businesses[0].capabilities_source, 'publisher_declared');
    assert.equal((await cli(['get',registered.business_id],true)).name, listing.name);
    const changes = join(dir, 'changes.json'); writeFileSync(changes, JSON.stringify({ description: 'Updated fictional demo service' }));
    const updated = await cli(['update',registered.business_id,'--data-file',changes]);
    assert.equal(updated.status, 'pending'); assert.notEqual(updated.verification.body.challenge,registered.verification.body.challenge);
    await assert.rejects(cli(['verify',registered.business_id]), /422/);
    documents.set(updated.verification.url, updated.verification.body);
    await cli(['verify',registered.business_id]);
    assert.equal((await cli(['check',registered.business_id])).status, 'active');
    await cli(['pause',registered.business_id]);
    assert.equal((await cli(['mine'])).businesses[0].status, 'paused');
    assert.equal((await cli(['search'], true)).businesses.length, 0);
    assert.equal((await fetch(base + '/cli/registry.mjs')).status, 200);
    assert.match(await (await fetch(base + '/skills/business-registry/SKILL.md')).text(), /name: business-registry/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); registry.close(); rmSync(dir,{recursive:true,force:true});
  }
});
