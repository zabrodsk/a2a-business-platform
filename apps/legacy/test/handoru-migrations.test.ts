import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { type Actor, type ServiceSpec } from '../../../packages/contracts/index.js';
import { ensureAuditSchema } from '../../../packages/audit/index.js';
import { HandoruStore, AUDIT_SCOPES } from '../src/handoru/store.js';
import { importCompatibility, authorizeOperation } from '../src/handoru/onboarding.js';
import { prepareHandover, commitHandover, type ExternalAccess } from '../src/handoru/handover.js';

const origin = 'https://pneu007.example';
const compatibilityToken = 'test-only-pre-upgrade-business-token';
const rulebookHash = 'test-approved-rulebook-hash';
const clock = () => new Date('2026-10-09T08:00:00Z');
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'handoru-migration-'));
  const path = join(dir, 'legacy.sqlite');
  let legacy = new LegacyStore(path, { now: clock });
  let h = new HandoruStore(legacy.db, origin, clock);
  t.after(() => { legacy.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get legacy() { return legacy; }, get h() { return h; },
    restart() { legacy.close(); legacy = new LegacyStore(path, { now: clock }); h = new HandoruStore(legacy.db, origin, clock); },
  };
}
function tokens(): Map<string, Actor> {
  return new Map([[compatibilityToken, { id: 'pre-upgrade-business-agent', role: 'business_agent' }]]);
}
function imported(t: TestContext) {
  const f = fixture(t);
  // Simulate an existing, explicitly owner-approved installation before upgrade.
  // This is migration test input; fresh production state must never seed it.
  ensureAuditSchema(f.legacy.db);
  f.legacy.db.prepare(`INSERT INTO audit_rulebook_versions(status,proposed_by,created_at,
    activated_by,activated_at,payload_json,manifest_json,business_id,record_kind)
    VALUES('active','pre-upgrade-business-agent',?,'pre-upgrade-human-owner',?,?,?,'pneu007','rulebook')`)
    .run(clock().toISOString(), clock().toISOString(), JSON.stringify({ test_fixture_only: true }), '[]');
  importCompatibility(f.h, tokens(), false);
  const owner = f.h.signup('owner@example.com', 'test-only owner passphrase', 'separate-setup', 'separate-setup');
  f.h.db.prepare('INSERT INTO handoru_memberships VALUES(?,?)').run(owner.id, 'pneu007');
  return { ...f, owner, get h() { return f.h; }, get legacy() { return f.legacy; }, restart: () => f.restart() };
}
function candidate(h: HandoruStore, owner: ReturnType<HandoruStore['signup']>, runtime: string, ready = true) {
  const pending = h.register({ runtime, legacy_url: origin });
  const approval = h.decide(owner, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const issued = h.exchange(pending.request_id, pending.provisional_credential);
  if (ready) h.db.prepare('UPDATE handoru_connections SET ready_json=? WHERE id=?')
    .run(JSON.stringify({ probe_passed: true, rulebook_hash: rulebookHash }), approval.connection_id!);
  return { id: approval.connection_id!, token: issued.access_token, actor: h.identify(issued.access_token)! };
}
function prepare(h: HandoruStore, owner: ReturnType<HandoruStore['signup']>, target: string, external_access: ExternalAccess[] = [], required: string[] = []) {
  return prepareHandover(h, owner, 'pneu007', {
    source_connection_id: 'compatibility-pneu007', target_connection_id: target,
    expected_epoch: 1, rulebook_hash: rulebookHash, external_access,
  }, required);
}
function allRows(legacy: LegacyStore, table: string) {
  return legacy.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

test('additive Handle migration and restart preserve existing order, quote, booking, payment and audit bytes', t => {
  const f = fixture(t);
  const tables = ['customers', 'quotes', 'orders', 'bookings', 'payments', 'ledger_entries', 'audit_events'];
  const before = Object.fromEntries(tables.map(table => [table, JSON.stringify(allRows(f.legacy, table))]));
  importCompatibility(f.h, tokens(), false);
  f.restart();
  importCompatibility(f.h, tokens(), false);
  for (const table of tables) assert.equal(JSON.stringify(allRows(f.legacy, table)), before[table], table);
  assert.ok(f.h.identify(compatibilityToken));
  assert.equal(f.h.installation()?.id, 'pneu007');
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_connections').get() as { n: number }).n, 1);
});

test('fresh mode ignores configured compatibility business credentials without seeding platform identity', t => {
  const f = fixture(t);
  importCompatibility(f.h, tokens(), true);
  assert.equal(f.h.installation(), undefined);
  assert.equal(f.h.identify(compatibilityToken), undefined);
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_credentials').get() as { n: number }).n, 0);
  assert.ok(f.legacy.listOrders().length > 0);
});

test('unapproved compatibility import is audit-only and does not activate autonomous operations', t => {
  const f = fixture(t);
  importCompatibility(f.h, tokens(), false);
  const actor = f.h.identify(compatibilityToken)!;
  assert.ok(actor);
  assert.equal(f.h.business('pneu007').active_connection_id, null);
  assert.equal(f.h.business('pneu007').execution_epoch, 0);
  assert.equal(f.h.connection(actor.connection_id!).state, 'audit_only');
  assert.deepEqual(actor.scopes, AUDIT_SCOPES);
  assert.throws(() => f.h.authorize(actor, 'pneu007', 'orders.checkout', true));
  f.restart();
  importCompatibility(f.h, tokens(), false);
  assert.equal(f.h.business('pneu007').active_connection_id, null);
  assert.equal(f.h.connection(actor.connection_id!).state, 'audit_only');
});

test('compatibility import is one-time and cannot resurrect a revoked token on restart or env rotation', t => {
  const f = imported(t);
  f.h.revoke(f.owner, 'pneu007', 'compatibility-pneu007');
  const epoch = f.h.business('pneu007').execution_epoch;
  f.restart();
  importCompatibility(f.h, tokens(), false);
  importCompatibility(f.h, new Map([['replacement-env-token', { id: 'new-env-agent', role: 'business_agent' }]]), false);
  assert.equal(f.h.identify(compatibilityToken), undefined);
  assert.equal(f.h.identify('replacement-env-token'), undefined);
  assert.equal(f.h.business('pneu007').execution_epoch, epoch);
  assert.equal(f.h.business('pneu007').active_connection_id, null);
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_connections').get() as { n: number }).n, 1);
});

test('atomic operation retries after restart return the original domain ID and reject changed payload', t => {
  const f = imported(t), actor = f.h.identify(compatibilityToken)!;
  const input = { customer_id: 'customer-001', service_spec: service, slot_id: 'slot-main' };
  const before = f.legacy.listOrders().length;
  const original = f.h.operation(actor, 'customer-order-1', 'order.create', input, 'cases.quote', () => {
    const quote = f.legacy.createQuote(input);
    return f.legacy.createOrder(quote.id);
  });
  assert.equal(f.legacy.listOrders().length, before + 1);
  f.restart();
  const replay = f.h.operation(f.h.identify(compatibilityToken)!, 'customer-order-1', 'order.create',
    { slot_id: input.slot_id, service_spec: input.service_spec, customer_id: input.customer_id }, 'cases.quote',
    () => { throw new Error('A committed operation must not execute again'); });
  assert.deepEqual(replay, original);
  assert.equal(f.legacy.listOrders().length, before + 1);
  assert.throws(() => f.h.operation(f.h.identify(compatibilityToken)!, 'customer-order-1', 'order.create',
    { ...input, customer_id: 'customer-002' }, 'cases.quote', () => original), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('operation transaction rolls back domain mutations when the result cannot be committed', t => {
  const f = imported(t), actor = f.h.identify(compatibilityToken)!;
  const before = JSON.stringify(allRows(f.legacy, 'quotes'));
  const input = { customer_id: 'customer-001', service_spec: service, slot_id: 'slot-main' };
  assert.throws(() => f.h.operation(actor, 'failed-operation', 'quote.create', input, 'cases.quote', () => {
    f.legacy.createQuote(input);
    throw new Error('Injected failure after local domain mutation');
  }), /Injected failure/);
  assert.equal(JSON.stringify(allRows(f.legacy, 'quotes')), before);
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_operations').get() as { n: number }).n, 0);
  assert.throws(() => f.h.operation(actor, 'async-operation', 'quote.create', input, 'cases.quote', () => {
    f.legacy.createQuote(input);
    return Promise.resolve({ impossible_atomic_external_result: true });
  }), { code: 'ASYNC_ATOMIC_OPERATION' });
  assert.equal(JSON.stringify(allRows(f.legacy, 'quotes')), before);
});

test('handover rejects an unready target and stale rulebook acknowledgement', t => {
  const f = imported(t), b = candidate(f.h, f.owner, 'runtime-B', false);
  assert.throws(() => prepare(f.h, f.owner, b.id), { code: 'CAPABILITY_PROBE_REQUIRED' });
  f.h.db.prepare('UPDATE handoru_connections SET ready_json=? WHERE id=?')
    .run(JSON.stringify({ probe_passed: true, rulebook_hash: 'old-rulebook' }), b.id);
  assert.throws(() => prepare(f.h, f.owner, b.id), { code: 'CAPABILITY_PROBE_REQUIRED' });
  assert.equal(f.h.business('pneu007').active_connection_id, 'compatibility-pneu007');
});

test('external session revocation and uncertain browser writes block exclusive handover', t => {
  const f = imported(t), b = candidate(f.h, f.owner, 'runtime-B');
  for (const access of [
    [],
    [{ system_id: 'external-crm', state: 'controlled_native' as const, evidence: 'Agent merely claims this foreign system is controlled' }],
    [{ system_id: 'external-crm', state: 'revocation_pending' as const, evidence: 'Admin session still valid' }],
    [{ system_id: 'external-crm', state: 'verified_revoked' as const, evidence: 'Native key rotated' }, { system_id: 'external-crm', state: 'uncertain_write' as const, evidence: 'Browser submitted order but timed out' }],
  ]) {
    const handoff = prepare(f.h, f.owner, b.id, access, ['external-crm']);
    assert.equal(handoff.state, 'external_access_revocation_pending');
    assert.throws(() => commitHandover(f.h, f.owner, 'pneu007', handoff.id, rulebookHash), { code: 'EXTERNAL_ACCESS_REVOCATION_PENDING' });
  }
  assert.ok(f.h.identify(compatibilityToken), 'Pending exclusive cutover must not report a successful switch');
  const verified = prepare(f.h, f.owner, b.id,
    [{ system_id: 'external-crm', state: 'verified_revoked', evidence: 'Owner verified old native session returns401 after rotation' }], ['external-crm']);
  assert.equal(verified.state, 'prepared');
});

test('competing owner commits at one epoch have one winner, revoke A and persist exactly one active runtime', async t => {
  const f = imported(t), a = f.h.identify(compatibilityToken)!;
  const b = candidate(f.h, f.owner, 'runtime-B'), c = candidate(f.h, f.owner, 'runtime-C');
  const bHandoff = prepare(f.h, f.owner, b.id), cHandoff = prepare(f.h, f.owner, c.id);
  const results = await Promise.allSettled([bHandoff, cHandoff].map(handoff =>
    Promise.resolve().then(() => commitHandover(f.h, f.owner, 'pneu007', handoff.id, rulebookHash))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(f.h.business('pneu007').execution_epoch, 2);
  assert.equal(f.h.identify(compatibilityToken), undefined);
  assert.throws(() => f.h.authorize(a, 'pneu007', 'orders.checkout', true));
  assert.throws(() => f.h.authorize(b.actor, 'pneu007', 'orders.checkout', true), { code: 'STALE_EXECUTION' });
  assert.equal(f.h.business('pneu007').active_connection_id, b.id);
  assert.equal(f.h.identify(b.token)?.execution_epoch, 2);
  f.restart();
  importCompatibility(f.h, tokens(), false);
  assert.equal(f.h.business('pneu007').active_connection_id, b.id);
  assert.equal(f.h.identify(compatibilityToken), undefined);
  assert.equal((f.h.db.prepare("SELECT count(*) AS n FROM handoru_connections WHERE state='active'").get() as { n: number }).n, 1);
  assert.deepEqual(commitHandover(f.h, f.owner, 'pneu007', bHandoff.id, rulebookHash),
    { id: bHandoff.id, state: 'committed', execution_epoch: 2 });
});

test('handover cannot broaden a candidate into active runtime without owner commit', t => {
  const f = imported(t), b = candidate(f.h, f.owner, 'runtime-B');
  assert.throws(() => authorizeOperation(f.h, f.owner, 'pneu007', b.id,
    { scopes: ['orders.checkout'], expected_epoch: 1 }, rulebookHash), { code: 'HANDOVER_REQUIRED' });
  assert.throws(() => f.h.authorize(b.actor, 'pneu007', 'orders.checkout', true));
  assert.equal(f.h.business('pneu007').active_connection_id, 'compatibility-pneu007');
});

test('accepted operation survives runtime replacement without rewriting customer authorization payload', t => {
  const f = imported(t), a = f.h.identify(compatibilityToken)!;
  const authorization = {
    accepted_by: 'customer-agent-A', customer_id: 'customer-001', mandate_id: 'approved-mandate-original',
    quote_id: 'immutable-quote-original', quote_version: 7, seller_id: 'original-seller', network: 'Preprod',
    asset: 'lovelace', max_network_fee: '2000000', asset_quantity: '5000000', nonce: 'original-purchaser-nonce',
  };
  const original = f.h.operation(a, 'accepted-checkout', 'checkout.accept', authorization, 'orders.checkout',
    () => ({ intent_id: 'original-intent', authorization }));
  const persistedBefore = f.h.db.prepare('SELECT payload_hash,result_json FROM handoru_operations').get();
  const b = candidate(f.h, f.owner, 'runtime-B'), handoff = prepare(f.h, f.owner, b.id);
  commitHandover(f.h, f.owner, 'pneu007', handoff.id, rulebookHash);
  const continued = f.h.operation<typeof original>(f.h.identify(b.token)!, 'accepted-checkout', 'checkout.accept', authorization, 'orders.checkout',
    () => { throw new Error('Successor must reuse the accepted operation'); });
  assert.deepEqual(continued, original);
  assert.deepEqual(f.h.db.prepare('SELECT payload_hash,result_json FROM handoru_operations').get(), persistedBefore);
  assert.equal(continued.authorization.accepted_by, 'customer-agent-A');
  assert.throws(() => f.h.operation(f.h.identify(b.token)!, 'accepted-checkout', 'checkout.accept',
    { ...authorization, accepted_by: b.actor.id }, 'orders.checkout', () => original), { code: 'IDEMPOTENCY_CONFLICT' });
});
