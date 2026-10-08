import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SourceRegistry, type Citation, type RulebookProposal } from '../../../packages/audit/index.js';
import type { Actor, ServiceSpec } from '../../../packages/contracts/index.js';
import { loadLegacyConfig } from '../src/config.js';
import { createLegacy } from '../src/server.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const business: Actor = { id: 'garage-demo', role: 'business_agent' };
const tokens = { business: 'tools-business-test-0123456789', a: 'tools-customer-a-test-0123456789', b: 'tools-customer-b-test-0123456789' };
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
const from = '2026-10-16T00:00:00+02:00', to = '2026-10-17T00:00:00+02:00';

// Explicit test-authored audit; production setup must obtain the business bot's own proposal.
function proposal(registry: SourceRegistry): RulebookProposal {
  const cite = (id: string): Citation => { const source = registry.get(id); return { source_id: id, version: source.version, hash: source.hash, excerpt: source.content }; };
  const params = registry.config();
  const operationFields = ['auto_discount_bps', 'owner_approval_limit_bps', 'hard_discount_limit_bps', 'offer_ttl_seconds', 'deposit_minor'];
  return { params, evidence: Object.fromEntries(Object.keys(params).map(key => [key, [cite(key === 'supplier_allowed_actions' ? 'internal-partners' : operationFields.includes(key) ? 'internal-operations' : 'internal-systems')]])) as RulebookProposal['evidence'],
    profile: { name: 'Pneu 007 test fixture', summary: 'Test-authored business tool proposal.', systems: ['legacy-orders'], partners: ['demo-supplier'], channels: ['web'], citations: [cite('internal-systems')] }, findings: [] };
}

test('bundled business tools book persistently, filter assigned reservations and preserve authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-business-tools-'));
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  cpSync(join(root, 'fixtures/internal'), join(dir, 'fixtures/internal'), { recursive: true });
  const systemsPath = join(dir, 'fixtures/internal/systems.json');
  const systems = JSON.parse(readFileSync(systemsPath, 'utf8'));
  systems.facts.provider = 'local_demo'; systems.facts.network = 'local';
  writeFileSync(systemsPath, JSON.stringify(systems));
  const registry = new SourceRegistry(dir, []);
  const cfg = loadLegacyConfig({ NODE_ENV: 'production', LEGACY_PORT: '0', LEGACY_PUBLIC_URL: 'http://127.0.0.1', LEGACY_DB_PATH: join(dir, 'business.sqlite'),
    LEGACY_OWNER_PASSWORD: 'tools-owner-password-0123456789', LEGACY_STAFF_PASSWORD: 'tools-staff-password-0123456789',
    LEGACY_CUSTOMER_A_PASSWORD: 'tools-customer-a-password-0123456789', LEGACY_CUSTOMER_B_PASSWORD: 'tools-customer-b-password-0123456789',
    LEGACY_BUSINESS_AGENT_TOKEN: tokens.business, LEGACY_CUSTOMER_AGENT_A_TOKEN: tokens.a, LEGACY_CUSTOMER_AGENT_B_TOKEN: tokens.b,
    LEGACY_RELAY_ADMIN_TOKEN: 'tools-relay-admin-test-0123456789', PAYMENT_PROVIDER: 'local_demo', LEGACY_RECONCILIATION_MS: '60000' });
  const options = { registry, now: () => new Date('2026-10-08T08:00:00Z') };
  const system = createLegacy(cfg, options);
  const server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify({ status: response.status, result }));
    return result;
  };
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, [join(root, 'packages/agent-client/dist/garage.mjs'), '--url', base, '--allow-http-localhost', ...args], { env: { ...process.env, PNEU007_TOOL_TOKEN: tokens.business }, timeout: 10000 });
    assert.ok(!result.stdout.includes(tokens.business));
    return JSON.parse(result.stdout);
  };
  let bookingId = '', orderId = '';
  try {
    const manifest = await request('/api/agent/tools', tokens.business);
    assert.ok(manifest.tools.some((tool: { name: string }) => tool.name === 'reservations'));
    assert.ok(!JSON.stringify(manifest).includes(tokens.business));
    assert.equal((await fetch(base + '/api/agent/reservations')).status, 401);
    assert.equal((await fetch(base + '/api/agent/reservations', { headers: { authorization: `Bearer ${tokens.a}` } })).status, 403);
    await assert.rejects(cli('availability', '--service', 'tyre_change'), /RULEBOOK_INACTIVE/);
    const proposalPath = join(dir, 'proposal.json'); writeFileSync(proposalPath, JSON.stringify(proposal(registry)));
    const proposed = await cli('propose-rulebook', '--data-file', proposalPath);
    system.rulebooks.activate({ id: 'staff-owner', role: 'owner' }, proposed.rulebook.version);
    const pricePath = join(dir, 'price.json'); writeFileSync(pricePath, JSON.stringify({ service_spec: service }));
    assert.equal((await cli('price', '--data-file', pricePath)).total_minor, 247200);
    const available = await cli('availability', '--service', 'tyre_change', '--from', from, '--to', to);
    assert.equal(available.timezone, 'Europe/Prague');
    assert.ok(available.slots.some((slot: { id: string }) => slot.id === 'slot-main'));
    assert.ok(available.slots.every((slot: { start_at: string }) => slot.start_at >= new Date(from).toISOString() && slot.start_at < new Date(to).toISOString()));
    await assert.rejects(cli('availability', '--from', to, '--to', from), /INVALID_DATE_RANGE/);
    await assert.rejects(cli('reservations', '--from', 'invalid'), /INVALID_DATE_RANGE/);
    const quotePath = join(dir, 'quote.json'); writeFileSync(quotePath, JSON.stringify({ slot_id: 'slot-main', discount_bps: 0 }));
    const prepare = async (token: string, customerId: string) => {
      const c = (await request('/api/agent/cases', token, { service_spec: service })).case;
      const m = (await request('/api/agent/mandates', token, { case_id: c.id, mode: 'book', service_spec: service, max_total_minor: 250000, max_deposit_minor: 50000,
        payment_mode: 'deposit', latest_service_end: '2026-10-17T22:00:00Z', expires_at: '2026-10-08T10:00:00Z', allow_extras: false, currency: 'CZK', network: 'local', asset: 'lovelace',
        max_asset_quantity: '25000000', max_network_fee: '2000000', mapping_version: 'demo-map-v1', seller_id: 'pneu007-demo' })).mandate;
      // Human approval is a test fixture, not an action exposed by the business CLI.
      system.policy.approveMandate({ id: `human-${customerId}`, role: 'human_customer', customer_id: customerId }, m.id);
      const q = await cli('quote', c.id, '--data-file', quotePath);
      const accepted = await request(`/api/agent/cases/${c.id}/accept`, token, { quote_id: q.quote.id, mandate_id: m.id });
      return accepted.order.id as string;
    };
    orderId = await prepare(tokens.a, 'customer-001');
    const competing = await prepare(tokens.b, 'customer-002');
    assert.equal((await cli('order', orderId)).booking, null);
    const booked = await cli('checkout', orderId);
    assert.equal(booked.booking.status, 'confirmed'); bookingId = booked.booking.id;
    assert.equal(booked.payment.provider, 'local_demo');
    assert.equal((await cli('checkout', orderId)).booking.id, bookingId);
    await assert.rejects(cli('checkout', competing), /SLOT_CONFLICT/);
    const reservations = await cli('reservations', '--from', from, '--to', to, '--status', 'confirmed');
    assert.deepEqual(reservations.reservations.map((r: { id: string }) => r.id), [bookingId]);
    assert.equal(reservations.scope, 'assigned_agent_cases');
    assert.equal((await cli('reservations', '--status', 'cancelled')).reservations.length, 0);
    assert.ok(!(await cli('availability', '--from', from, '--to', to)).slots.some((slot: { id: string }) => slot.id === 'slot-main'));
    for (const action of ['cancel', 'reschedule']) {
      const denied = await fetch(`${base}/api/admin/orders/${orderId}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.business}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 403);
    }
    const skill = await fetch(base + '/skills/pneu007-business/SKILL.md'); assert.equal(skill.status, 200);
    assert.match(await skill.text(), /name: pneu007-business/);
  } finally {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await system.close();
    try {
      if (bookingId) {
        const reopened = createLegacy(cfg, options);
        try {
          assert.equal(reopened.store.calendar('customer-001').find(value => value.order_id === orderId)?.id, bookingId);
          assert.deepEqual(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE order_id=?').get(orderId), { n: 1 });
        } finally { await reopened.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
