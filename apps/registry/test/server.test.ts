import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRegistry, HEALTH_TTL_MS, MAX_BUSINESSES, type RegistryOptions } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const adminToken = 'test-admin-token-with-at-least-24-characters';
const input = {
  name: 'Demo Garage', description: 'Tire services', website: 'https://garage.example',
  agent_card_url: 'https://garage.example/.well-known/agent-card.json', services: ['tyre_change'], actions: ['quote', 'book'],
  location: { latitude: 50.08, longitude: 14.43, address: 'Prague' },
};
const card = {
  name: 'Garage agent', skills: [{ id: 'tyre-service-negotiation' }],
  supportedInterfaces: [{ url: 'https://garage.example/a2a', protocolVersion: '1.0', protocolBinding: 'JSONRPC' }],
};
async function fixture(options: RegistryOptions = {}, dbPath = ':memory:') {
  const documents = new Map<string, unknown>([[input.agent_card_url, card]]);
  const registry = createRegistry({ dbPath, port: 8792, host: '127.0.0.1', adminToken }, { startHealthTimer: false, fetchJson: async url => {
    if (!documents.has(url)) throw new Error('Missing remote document');
    return documents.get(url);
  }, ...options });
  const server = registry.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(`${url}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  async function issue() { const result = await api('/api/publishers', 'POST', { name: 'Garage owner' }, adminToken); assert.equal(result.status, 201); return result.data.token as string; }
  async function register(token: string, listing = input) {
    const result = await api('/api/businesses', 'POST', listing, token);
    assert.equal(result.status, 201);
    documents.set(result.data.verification.url, result.data.verification.body);
    return result.data;
  }
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); registry.close(); }
  return { registry, documents, api, issue, register, close };
}

test('registration, ownership verification, metadata, and public search lifecycle', async () => {
  const f = await fixture();
  try {
    const token = await f.issue(), listing = await f.register(token);
    assert.equal(listing.status, 'pending');
    assert.equal((await f.api(`/api/businesses/${listing.business_id}`)).status, 404);
    assert.equal((await f.api('/api/search')).data.total, 0);
    const repeat = await f.api('/api/businesses', 'POST', input, token);
    assert.equal(repeat.status, 200); assert.equal(repeat.data.business_id, listing.business_id);
    assert.equal((await f.api(`/api/businesses/${listing.business_id}/verify`, 'POST', undefined, token)).status, 200);
    const result = await f.api('/api/search?service=tyre_change&action=book');
    assert.equal(result.data.total, 1);
    const found = result.data.businesses[0];
    assert.equal(found.verification, undefined); assert.equal(found.publisher_id, undefined);
    assert.equal(found.verification_scope, 'domain_control_and_card_metadata');
    assert.equal(found.capabilities_source, 'publisher_declared');
    assert.equal((await f.api('/api/search?action=cancel')).data.total, 0);
    assert.equal((await f.api('/api/search?q=prague')).data.total, 1);
    assert.equal((await f.api('/api/me/businesses', 'GET', undefined, token)).data.businesses.length, 1);
  } finally { await f.close(); }
});

test('publisher authentication and ownership isolation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api('/api/publishers', 'POST', { name: 'bad' })).status, 401);
    assert.equal((await f.api('/api/publishers', 'POST', { name: 'bad' }, 'wrong')).status, 401);
    assert.equal((await f.api('/api/businesses', 'POST', input, adminToken)).status, 401);
    const owner = await f.issue(), outsider = await f.issue(), listing = await f.register(owner);
    assert.equal((await f.api('/api/businesses', 'POST', input, outsider)).status, 409);
    for (const operation of ['verify', 'check', 'pause']) assert.equal((await f.api(`/api/businesses/${listing.business_id}/${operation}`, 'POST', undefined, outsider)).status, 404);
    assert.equal((await f.api(`/api/businesses/${listing.business_id}`, 'PATCH', { name: 'Hijack' }, outsider)).status, 404);
    assert.equal((await f.api('/api/me/businesses', 'GET', undefined, outsider)).data.businesses.length, 0);
  } finally { await f.close(); }
});

test('failed ownership/card checks and stale health hide listings', async () => {
  let now = Date.UTC(2026, 9, 8);
  const f = await fixture({ now: () => now });
  try {
    const token = await f.issue(), listing = await f.register(token), path = `/api/businesses/${listing.business_id}`;
    f.documents.set(listing.verification.url, { business_id: listing.business_id, challenge: 'wrong' });
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 422);
    f.documents.set(listing.verification.url, listing.verification.body);
    f.documents.set(input.agent_card_url, { ...card, supportedInterfaces: [{ url: 'https://other.example/a2a', protocolVersion: '1.0', protocolBinding: 'JSONRPC' }] });
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 422);
    f.documents.set(input.agent_card_url, card);
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 200);
    now += HEALTH_TTL_MS;
    assert.equal((await f.api('/api/search')).data.total, 0);
    assert.equal((await f.api(path)).status, 404);
    assert.equal((await f.api(`${path}/check`, 'POST', undefined, token)).status, 200);
    assert.equal((await f.api('/api/search')).data.total, 1);
    f.documents.delete(input.agent_card_url);
    assert.equal((await f.api(`${path}/check`, 'POST', undefined, token)).status, 422);
    assert.equal((await f.api('/api/search')).data.total, 0);
    f.documents.set(input.agent_card_url, card);
    await f.registry.checkHealth();
    assert.equal((await f.api('/api/search')).data.total, 1);
  } finally { await f.close(); }
});

test('pause stays hidden during health checks; edit requires a fresh proof', async () => {
  const f = await fixture();
  try {
    const token = await f.issue(), listing = await f.register(token), path = `/api/businesses/${listing.business_id}`;
    await f.api(`${path}/verify`, 'POST', undefined, token);
    assert.equal((await f.api(`${path}/pause`, 'POST', undefined, token)).data.status, 'paused');
    await f.registry.checkHealth();
    assert.equal((await f.api('/api/search')).data.total, 0);
    assert.equal((await f.api(`${path}/check`, 'POST', undefined, token)).status, 409);
    const updated = await f.api(path, 'PATCH', { name: 'Updated garage' }, token);
    assert.equal(updated.data.status, 'paused'); assert.equal(updated.data.verified_at, null);
    assert.notEqual(updated.data.verification.body.challenge, listing.verification.body.challenge);
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 422);
    f.documents.set(updated.data.verification.url, updated.data.verification.body);
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).data.status, 'active');
    assert.equal((await f.api(path, 'PATCH', { description: 'Updated services' }, token)).data.status, 'pending');
    assert.equal((await f.api('/api/search')).data.total, 0);
  } finally { await f.close(); }
});

test('stale in-flight verification cannot reactivate a paused or edited listing', async () => {
  for (const operation of ['pause', 'edit']) {
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let proof: unknown;
    const f = await fixture({ fetchJson: async url => { if (url.endsWith('business-registry-verification.json')) { entered(); await wait; return proof; } return card; } });
    try {
      const token = await f.issue(), listing = await f.register(token), path = `/api/businesses/${listing.business_id}`;
      proof = listing.verification.body;
      const verification = f.api(`${path}/verify`, 'POST', undefined, token);
      await started;
      if (operation === 'pause') await f.api(`${path}/pause`, 'POST', undefined, token);
      else await f.api(path, 'PATCH', { name: 'Edited while checking' }, token);
      release();
      assert.equal((await verification).status, 409);
      assert.equal((await f.api('/api/search')).data.total, 0);
      const saved = (await f.api('/api/me/businesses', 'GET', undefined, token)).data.businesses[0];
      assert.equal(saved.status, operation === 'pause' ? 'paused' : 'pending');
      assert.equal(saved.verified_at, null);
    } finally { release(); await f.close(); }
  }
});

test('search validates parameters, filters distance, and paginates', async () => {
  const f = await fixture();
  try {
    const token = await f.issue(), listing = await f.register(token);
    await f.api(`/api/businesses/${listing.business_id}/verify`, 'POST', undefined, token);
    const nearby = await f.api('/api/search?lat=50.08&lon=14.43&radius_km=1&limit=1');
    assert.equal(nearby.data.total, 1); assert.equal(nearby.data.businesses[0].distance_km, 0);
    assert.equal((await f.api('/api/search?lat=49&lon=14&radius_km=1')).data.total, 0);
    assert.equal((await f.api('/api/search?offset=1')).data.businesses.length, 0);
    for (const query of ['lat=1', 'lon=1', 'radius_km=5', 'lat=91&lon=0', 'lat=NaN&lon=0', 'lat=1&lon=Infinity', 'limit=0', 'offset=-1', 'limit=1.5', 'action=delete', 'service=bad%20id', 'extra=1', 'q=', 'limit=1&limit=2']) assert.equal((await f.api(`/api/search?${query}`)).status, 400, query);
  } finally { await f.close(); }
});

test('listing validation rejects unknown fields, credentials, and malformed locations', async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    for (const changed of [{ website: 'http://garage.example' }, { website: 'https://garage.example/path' }, { website: 'https://garage.example.' }, { website: 'https://garage.example:8443' }, { agent_card_url: 'https://garage.example/card#' }, { website: 'https://u:p@garage.example' }, { agent_card_url: 'https://other.example/card' }, { agent_card_url: 'https://garage.example/card#secret' }, { services: [] }, { actions: ['sql'] }, { password: 'secret' }, { location: { latitude: 91, longitude: 1, address: 'x' } }]) assert.equal((await f.api('/api/businesses', 'POST', { ...input, ...changed }, token)).status, 400, JSON.stringify(changed));
  } finally { await f.close(); }
});

test('publisher tokens and listing verification survive database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'registry-'));
  let f = await fixture({}, join(directory, 'registry.db'));
  try {
    const token = await f.issue(), listing = await f.register(token);
    await f.api(`/api/businesses/${listing.business_id}/verify`, 'POST', undefined, token);
    await f.close();
    f = await fixture({}, join(directory, 'registry.db'));
    assert.equal((await f.api('/api/me/businesses', 'GET', undefined, token)).data.businesses[0].business_id, listing.business_id);
    assert.equal((await f.api('/api/search')).data.total, 1);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('configuration requires strong token and supports Railway port/host defaults', () => {
  assert.throws(() => loadConfig({}), /REGISTRY_ADMIN_TOKEN/);
  assert.throws(() => loadConfig({ REGISTRY_ADMIN_TOKEN: adminToken, PORT: 'abc' }), /port/);
  assert.deepEqual(loadConfig({ REGISTRY_ADMIN_TOKEN: adminToken, PORT: '9000', NODE_ENV: 'production' }), { dbPath: 'data/registry.db', port: 9000, host: '0.0.0.0', adminToken, publicUrl: undefined });
});


test('total listing capacity includes pending records but preserves idempotent registration', async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const first = await f.register(token);
    for (let index = 1; index < MAX_BUSINESSES; index++) {
      const website = `https://garage-${index}.example`;
      await f.register(token, { ...input, website, agent_card_url: `${website}/.well-known/agent-card.json` });
    }
    const rejected = await f.api('/api/businesses', 'POST', { ...input, website: 'https://overflow.example', agent_card_url: 'https://overflow.example/card' }, token);
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.error, /capacity/i);
    const repeated = await f.api('/api/businesses', 'POST', input, token);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.business_id, first.business_id);
    assert.equal((await f.api('/api/me/businesses', 'GET', undefined, token)).data.businesses.length, MAX_BUSINESSES);
  } finally { await f.close(); }
});

test('free-text search folds Czech accents and case across name, description and address in both directions', async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const listing = await f.register(token, { ...input, name: 'Dílna U Mostu', description: 'Přezutí pneumatik',
      location: { ...input.location, address: 'Praha 7 – Holešovice' } });
    const path = `/api/businesses/${listing.business_id}`;
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 200);
    for (const q of ['Holesovice', 'HOLEŠOVICE', 'Holešovice'.normalize('NFD'), 'dilna', 'PREZUTI']) {
      const result = await f.api('/api/search?q=' + encodeURIComponent(q));
      assert.equal(result.data.total, 1, q);
      assert.equal(result.data.businesses[0].location.address, 'Praha 7 – Holešovice');
    }
    assert.equal((await f.api('/api/search?q=holesovice&service=wheel_swap')).data.total, 0);
    assert.equal((await f.api('/api/search?q=holesovice&action=cancel')).data.total, 0);
    assert.equal((await f.api('/api/search?q=holesovice&lat=49&lon=14&radius_km=1')).data.total, 0);
    const nearby = await f.api('/api/search?q=holesovice&lat=50.08&lon=14.43&radius_km=1');
    assert.equal(nearby.data.total, 1); assert.equal(nearby.data.businesses[0].distance_km, 0);

    const updated = await f.api(path, 'PATCH', { name: 'Dilna U Mostu', description: 'Prezuti pneumatik',
      location: { ...input.location, address: 'Praha 7 - Holesovice' } }, token);
    assert.equal(updated.status, 200);
    f.documents.set(updated.data.verification.url, updated.data.verification.body);
    assert.equal((await f.api(`${path}/verify`, 'POST', undefined, token)).status, 200);
    for (const q of ['Holešovice', 'DÍLNA', 'PŘEZUTÍ']) assert.equal((await f.api('/api/search?q=' + encodeURIComponent(q))).data.total, 1, q);
    assert.equal((await f.api('/api/search?q=Vinohrady')).data.total, 0);
  } finally { await f.close(); }
});
