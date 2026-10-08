import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { namedGarageRequest } from '../../../packages/agent-client/src/garage-tools.js';
import { loadLegacyConfig } from '../src/config.js';
import { createLegacy } from '../src/server.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const proofPath = '/.well-known/business-registry-verification.json';
const writePath = '/api/agent/registry-proof';
const tokens = {
  business: 'proof-business-test-0123456789', customer: 'proof-customer-a-test-0123456789',
  other: 'proof-other-business-test-0123456789', ownerAgent: 'proof-owner-agent-test-0123456789',
};

test('business agent publishes only fixed registry proof, with identity checks and restart persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-registry-proof-'));
  const cfg = loadLegacyConfig({ NODE_ENV: 'production', LEGACY_PORT: '0', LEGACY_PUBLIC_URL: 'http://127.0.0.1', LEGACY_DB_PATH: join(dir, 'business.sqlite'),
    LEGACY_OWNER_PASSWORD: 'proof-owner-password-0123456789', LEGACY_STAFF_PASSWORD: 'proof-staff-password-0123456789',
    LEGACY_CUSTOMER_A_PASSWORD: 'proof-customer-a-password-0123456789', LEGACY_CUSTOMER_B_PASSWORD: 'proof-customer-b-password-0123456789',
    LEGACY_BUSINESS_AGENT_TOKEN: tokens.business, LEGACY_CUSTOMER_AGENT_A_TOKEN: tokens.customer,
    LEGACY_CUSTOMER_AGENT_B_TOKEN: 'proof-customer-b-test-0123456789', LEGACY_OWNER_AGENT_TOKEN: tokens.ownerAgent,
    LEGACY_RELAY_ADMIN_TOKEN: 'proof-relay-admin-test-0123456789', PAYMENT_PROVIDER: 'local_demo', LEGACY_RECONCILIATION_MS: '60000' });
  cfg.auth.agentTokens.set(tokens.other, { id: 'another-business', role: 'business_agent' });
  const options = { now: () => new Date('2026-10-08T08:00:00Z') };
  let system = createLegacy(cfg, options);
  let server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const publish = (body: unknown, token?: string) => fetch(base + writePath, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const proof = { business_id: 'fa031988-99f0-4edb-b379-42bfa3173217', challenge: 'a'.repeat(43) };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await system.close();
  };
  try {
    const missing = await fetch(base + proofPath);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal((await publish(proof)).status, 401);
    for (const token of [tokens.customer, tokens.ownerAgent, tokens.other]) {
      assert.equal((await publish(proof, token)).status, 403);
    }
    const invalid: unknown[] = [
      [], null, { ...proof, path: '/index.html' }, { ...proof, url: 'https://example.com' },
      { ...proof, sql: 'DROP TABLE orders' }, { ...proof, business_id: '../index.html' },
      { ...proof, business_id: 42 }, { business_id: proof.business_id },
      { ...proof, challenge: 'a'.repeat(31) }, { ...proof, challenge: 'a'.repeat(129) },
      { ...proof, challenge: '<script>alert(1)</script>'.repeat(2) }, { ...proof, challenge: `${'a'.repeat(43)}\n` },
      JSON.parse(`{"business_id":"${proof.business_id}","challenge":"${proof.challenge}","__proto__":{}}`),
    ];
    for (const body of invalid) assert.equal((await publish(body, tokens.business)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(base + proofPath)).status, 404);
    assert.throws(() => system.rulebooks.getActive(), { code: 'RULEBOOK_INACTIVE' });
    assert.throws(() => namedGarageRequest(['publish-registry-proof'], new Map()), /requires --data-file/);
    assert.deepEqual(namedGarageRequest(['publish-registry-proof'], new Map([['--data-file', 'proof.json']])), { method: 'POST', path: writePath });
    const file = join(dir, 'proof.json');
    writeFileSync(file, JSON.stringify(proof));
    const result = await run(process.execPath, [join(root, 'packages/agent-client/dist/garage.mjs'), '--url', base,
      '--allow-http-localhost', 'publish-registry-proof', '--data-file', file], { env: { ...process.env, PNEU007_TOOL_TOKEN: tokens.business }, timeout: 10000 });
    assert.equal(JSON.parse(result.stdout).published, true);
    assert.ok(!result.stdout.includes(tokens.business));
    const published = await fetch(base + proofPath);
    assert.equal(published.status, 200);
    assert.match(published.headers.get('content-type')!, /application\/json/);
    assert.equal(published.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await published.json(), proof);
    const event = system.store.db.prepare("SELECT actor_id,data_json FROM audit_events WHERE event_type='website_proof_published'").get() as { actor_id: string; data_json: string };
    assert.equal(event.actor_id, 'garage-demo');
    assert.ok(!event.data_json.includes(proof.challenge));
    const replacement = { business_id: 'b9fd3f45-bd00-4c7a-b508-16af6ac590e5', challenge: 'b-_'.repeat(15) };
    assert.equal((await publish(replacement, tokens.business)).status, 200);
    await close();
    system = createLegacy(cfg, options);
    server = system.app.listen(0, '127.0.0.1');
    await new Promise<void>(done => server.once('listening', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual(await (await fetch(base + proofPath)).json(), replacement);
    assert.deepEqual(system.store.db.prepare('SELECT COUNT(*) AS n FROM business_registry_proof').get(), { n: 1 });
    assert.throws(() => system.rulebooks.getActive(), { code: 'RULEBOOK_INACTIVE' });
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only a human owner can create short-lived, hashed, one-use business enrollments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-agent-enrollment-'));
  const ownerPassword = 'enrollment-owner-password-0123456789';
  const cfg = loadLegacyConfig({ NODE_ENV: 'production', LEGACY_PORT: '0', LEGACY_PUBLIC_URL: 'http://127.0.0.1', LEGACY_DB_PATH: join(dir, 'business.sqlite'),
    LEGACY_OWNER_PASSWORD: ownerPassword, LEGACY_STAFF_PASSWORD: 'enrollment-staff-password-0123456789',
    LEGACY_CUSTOMER_A_PASSWORD: 'enrollment-customer-a-password-0123456789', LEGACY_CUSTOMER_B_PASSWORD: 'enrollment-customer-b-password-0123456789',
    LEGACY_BUSINESS_AGENT_TOKEN: tokens.business, LEGACY_CUSTOMER_AGENT_A_TOKEN: tokens.customer,
    LEGACY_CUSTOMER_AGENT_B_TOKEN: 'enrollment-customer-b-test-0123456789', LEGACY_OWNER_AGENT_TOKEN: tokens.ownerAgent,
    LEGACY_RELAY_ADMIN_TOKEN: 'enrollment-relay-admin-test-0123456789', PAYMENT_PROVIDER: 'local_demo', LEGACY_RECONCILIATION_MS: '60000' });
  let current = new Date('2026-10-08T08:00:00Z');
  const system = createLegacy(cfg, { now: () => current });
  const server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issue = (body: unknown, headers: Record<string, string> = {}) => fetch(base + '/api/admin/agent-enrollments', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const login = async (username: string, password: string) => {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': data.csrf_token as string };
  };
  const redeem = (url: string, method = 'POST') => fetch(base + new URL(url).pathname, { method });
  try {
    assert.equal((await issue({})).status, 401);
    for (const token of [tokens.business, tokens.customer, tokens.ownerAgent]) {
      assert.equal((await issue({}, { authorization: `Bearer ${token}` })).status, 403);
    }
    const staff = await login('staff', 'enrollment-staff-password-0123456789');
    assert.equal((await issue({}, staff)).status, 403);
    const owner = await login('owner', ownerPassword);
    assert.equal((await issue({}, { cookie: owner.cookie })).status, 403);
    for (const body of [[], null, { role: 'owner_agent' }, { ttl_minutes: 0 }, { ttl_minutes: 16 }, { ttl_minutes: 1.5 }, { ttl_minutes: '5' }]) {
      assert.equal((await issue(body, owner)).status, 400);
    }
    const created = await issue({}, owner);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const enrollment = await created.json();
    assert.equal(enrollment.expires_at, '2026-10-08T08:05:00.000Z');
    const code = new URL(enrollment.redeem_url).pathname.split('/').at(-1)!;
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    const stored = system.store.db.prepare('SELECT * FROM business_agent_enrollments').all();
    assert.ok(!JSON.stringify(stored).includes(code));
    assert.ok(!JSON.stringify(stored).includes(tokens.business));
    const preview = await redeem(enrollment.redeem_url, 'GET');
    assert.equal(preview.status, 405);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    const simultaneous = await Promise.all([redeem(enrollment.redeem_url), redeem(enrollment.redeem_url)]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [200, 404]);
    const success = simultaneous.find(response => response.status === 200)!;
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await success.json(), { role: 'business_agent', url: cfg.publicUrl, token: tokens.business });
    const another = await (await issue({ ttl_minutes: 1 }, owner)).json();
    current = new Date('2026-10-08T08:01:00Z');
    assert.equal((await redeem(another.redeem_url)).status, 404);
    const invalid = await redeem(`${base}/agent-enrollments/${'x'.repeat(43)}`);
    assert.equal(invalid.status, 404);
    const audit = JSON.stringify(system.store.db.prepare("SELECT * FROM audit_events WHERE event_type LIKE 'enrollment_%'").all());
    assert.ok(!audit.includes(tokens.business));
    assert.ok(!audit.includes(code));
    assert.ok(!audit.includes(new URL(another.redeem_url).pathname.split('/').at(-1)!));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await system.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
