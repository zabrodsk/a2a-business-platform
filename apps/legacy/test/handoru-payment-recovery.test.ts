import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LegacyStore, type PaymentIntent } from '../../../packages/demo-garage/index.js';
import { BusinessError, type Actor, type PaymentObservation, type PaymentProvider, type PaymentRequest, type PurchaseAuthorization, type ServiceSpec } from '../../../packages/contracts/index.js';
import { LocalDemoProvider } from '../../../packages/payments/index.js';
import { HandoruStore, ALL_SCOPES, AUDIT_SCOPES } from '../src/handoru/store.js';
import { importCompatibility } from '../src/handoru/onboarding.js';
import { prepareHandover, commitHandover } from '../src/handoru/handover.js';
import { PaymentWorkflow } from '../src/payment-workflow.js';

const clock = () => new Date('2026-10-09T08:00:00Z');
const token = 'payment-recovery-business-test-only';
const rulebookHash = 'test-current-approved-rulebook';
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Simulated remote state intentionally survives local restarts. No Preprod calls. */
class RecordedProvider implements PaymentProvider {
  readonly name = 'local_demo' as const;
  readonly local = new LocalDemoProvider({ now: clock });
  readonly starts: PaymentRequest[] = [];
  readonly remote = new Map<string, PaymentObservation>();
  readonly entered = deferred();
  readonly gate = deferred();
  blockStart = false;
  loseFirstResponse = false;
  async start(request: PaymentRequest) {
    this.starts.push(structuredClone(request));
    this.entered.resolve();
    if (this.blockStart) await this.gate.promise;
    const observed = await this.local.start(request);
    this.remote.set(request.intent_id, observed);
    if (this.loseFirstResponse) {
      this.loseFirstResponse = false;
      throw new BusinessError('TEST_PROVIDER_RESPONSE_LOST', 'Funding occurred but its response was lost', 503);
    }
    return observed;
  }
  async observe(request: PaymentRequest, previous?: PaymentObservation) {
    const prior = this.remote.get(request.intent_id) ?? previous;
    assert.ok(prior, 'Recovery must observe the original remote payment, not manufacture funding');
    const next = await this.local.observe(request, prior);
    this.remote.set(request.intent_id, next);
    return next;
  }
  async submitResult(request: PaymentRequest, previous: PaymentObservation, resultHash: string) {
    const next = await this.local.submitResult(request, previous, resultHash);
    this.remote.set(request.intent_id, next);
    return next;
  }
  async requestRefund(request: PaymentRequest, previous: PaymentObservation) {
    return this.local.requestRefund(request, previous);
  }
}
async function fixture(t: TestContext, provider = new RecordedProvider()) {
  const dir = mkdtempSync(join(tmpdir(), 'handoru-payment-recovery-'));
  const path = join(dir, 'legacy.sqlite');
  let store = new LegacyStore(path, { now: clock });
  let h = new HandoruStore(store.db, 'https://pneu007.example', clock);
  importCompatibility(h, new Map<string, Actor>([[token, { id: 'test-payment-runtime-A', role: 'business_agent' }]]), false);
  const owner = h.signup('payment-owner@example.test', 'test-only human owner password', 'separate-human-setup', 'separate-human-setup');
  h.db.prepare('INSERT INTO handoru_memberships VALUES(?,?)').run(owner.id, 'pneu007');
  // Explicit approved-runtime fixture. HTTP onboarding tests exercise the real grant ceremony.
  h.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
  h.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
  let workflow = new PaymentWorkflow(store, provider);
  t.after(async () => { provider.gate.resolve(); await workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get h() { return h; }, get workflow() { return workflow; }, provider, owner,
    async restart() {
      await workflow.close(); store.close(); store = new LegacyStore(path, { now: clock });
      h = new HandoruStore(store.db, 'https://pneu007.example', clock); workflow = new PaymentWorkflow(store, provider);
    },
  };
}
function prepare(store: LegacyStore, kind: PurchaseAuthorization['kind'] = 'agent_mandate', slot = 'slot-main') {
  const quote = store.createQuote({ customer_id: 'customer-001', service_spec: service, slot_id: slot });
  const order = store.createOrder(quote.id);
  const authorization: PurchaseAuthorization = {
    kind, actor_id: kind === 'agent_mandate' ? 'original-customer-agent' : 'original-human-customer',
    customer_id: order.customer_id, quote_id: quote.id, quote_version: quote.version, payment_mode: 'deposit',
    max_total_minor: quote.price.total_minor, max_deposit_minor: 50000, network: 'local', seller_id: 'pneu007-demo',
    asset: 'lovelace', asset_quantity: '5000000', max_network_fee: '2000000', mapping_version: 'demo-map-v1',
    approved_at: clock().toISOString(), ...(kind === 'agent_mandate' ? { mandate_id: 'original-approved-mandate', rulebook_version: 1 } : {}),
  };
  return { order, authorization, input: { authorization, provider: 'local_demo' as const, sku: 'deposit-500',
    asset_quantity: authorization.asset_quantity, max_network_fee: authorization.max_network_fee, seller_id: authorization.seller_id } };
}
function accepted(f: Awaited<ReturnType<typeof fixture>>) {
  const purchase = prepare(f.store);
  return f.h.operation(f.h.identify(token)!, `checkout:${purchase.order.id}`, 'orders.checkout',
    { order_id: purchase.order.id }, 'orders.checkout', () => f.store.prepareCheckout(purchase.order.id, purchase.input));
}
async function receipt(f: Awaited<ReturnType<typeof fixture>>, intent: PaymentIntent) {
  const deadline = Date.now() + 2000;
  while (!f.workflow.getReceipt(intent.intent_id) && Date.now() < deadline) await delay(10);
  assert.ok(f.workflow.getReceipt(intent.intent_id), 'The accepted operation must recover within the bounded polling interval');
  const recovered = f.store.getPaymentIntent(intent.intent_id);
  assert.equal(recovered.identifier_from_purchaser, intent.identifier_from_purchaser);
  assert.equal(recovered.input_hash, intent.input_hash);
  assert.deepEqual(recovered.authorization, intent.authorization);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM bookings WHERE order_id=?').get(intent.order_id) as { n: number }).n, 1);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM payments WHERE intent_id=?').get(intent.intent_id) as { n: number }).n, 1);
  return recovered;
}

test('restart after accepted checkout before provider dispatch finishes the original operation even after agent revocation', async t => {
  const f = await fixture(t), intent = accepted(f);
  assert.equal(intent.state, 'created');
  assert.equal(f.provider.starts.length, 0);
  f.h.revoke(f.owner, 'pneu007', 'compatibility-pneu007');
  await f.restart();
  assert.equal(f.h.identify(token), undefined);
  f.workflow.start(10);
  await receipt(f, intent);
  assert.equal(f.provider.starts.length, 1);
  assert.equal(f.provider.starts[0]!.intent_id, intent.intent_id);
});

test('approved human checkout also recovers after restart without a Handle agent operation', async t => {
  const f = await fixture(t), purchase = prepare(f.store, 'human_checkout');
  f.store.db.exec(`CREATE TABLE human_checkout_authorizations(order_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,authorization_json TEXT NOT NULL,approved_at TEXT NOT NULL)`);
  const intent = f.store.db.transaction(() => {
    f.store.db.prepare('INSERT INTO human_checkout_authorizations VALUES(?,?,?,?)').run(purchase.order.id,
      purchase.authorization.actor_id, JSON.stringify(purchase.authorization), clock().toISOString());
    return f.store.prepareCheckout(purchase.order.id, purchase.input);
  }).immediate();
  await f.restart();
  f.workflow.start(10);
  await receipt(f, intent);
  assert.equal(f.provider.starts.length, 1);
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_operations').get() as { n: number }).n, 0);
});

test('seller-only prepared job and unrelated journal entries never authorize buyer dispatch', async t => {
  const f = await fixture(t), seller = prepare(f.store);
  const sellerIntent = f.store.prepareCheckout(seller.order.id, seller.input);
  f.store.db.exec('CREATE TABLE masumi_jobs(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,identifier_from_purchaser TEXT NOT NULL,job_json TEXT NOT NULL,input_json TEXT NOT NULL)');
  f.store.db.prepare('INSERT INTO masumi_jobs VALUES(?,?,?,?,?)').run(sellerIntent.intent_id, sellerIntent.customer_id,
    sellerIntent.identifier_from_purchaser, JSON.stringify({ state: 'seller_prepared_only' }), '{}');
  f.h.operation(f.h.identify(token)!, 'seller-job-status', 'orders.inspect', {}, 'orders.checkout', () => sellerIntent);
  const nextSlot = f.store.availability().find(slot => slot.id !== 'slot-main')!;
  const authorized = prepare(f.store, 'agent_mandate', nextSlot.id);
  const acceptedIntent = f.h.operation(f.h.identify(token)!, `checkout:${authorized.order.id}`, 'orders.checkout',
    { order_id: authorized.order.id }, 'orders.checkout', () => f.store.prepareCheckout(authorized.order.id, authorized.input));
  await f.restart();
  f.workflow.start(10);
  await receipt(f, acceptedIntent);
  await delay(40);
  assert.equal(f.store.getPaymentIntent(sellerIntent.intent_id).state, 'created');
  assert.deepEqual(f.provider.starts.map(request => request.intent_id), [acceptedIntent.intent_id]);
  assert.equal(f.store.calendar().filter(booking => booking.order_id === sellerIntent.order_id).length, 0);
});

test('provider response loss after dispatch reconciles the original accepted payment on restart without a second start', async t => {
  const provider = new RecordedProvider(); provider.loseFirstResponse = true;
  const f = await fixture(t, provider), intent = accepted(f);
  assert.equal((await f.workflow.reconcile(intent.intent_id)).state, 'purchase_requested');
  assert.ok(f.workflow.error(intent.intent_id));
  assert.equal(provider.starts.length, 1);
  await f.restart();
  f.workflow.start(10);
  const recovered = await receipt(f, intent);
  assert.equal(provider.starts.length, 1);
  assert.equal(recovered.observation?.provider_payment_id, provider.remote.get(intent.intent_id)?.provider_payment_id);
});

test('owner handover during a blocked provider start preserves one dispatch, nonce and booking', { timeout: 5000 }, async t => {
  const provider = new RecordedProvider(); provider.blockStart = true;
  const f = await fixture(t, provider), intent = accepted(f);
  const running = f.workflow.reconcile(intent.intent_id);
  await provider.entered.promise;
  const pending = f.h.register({ runtime: 'test-payment-runtime-B', legacy_url: 'https://pneu007.example' });
  const approved = f.h.decide(f.owner, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const issued = f.h.exchange(pending.request_id, pending.provisional_credential);
  f.h.db.prepare('UPDATE handoru_connections SET ready_json=? WHERE id=?').run(JSON.stringify({ probe_passed: true, rulebook_hash: rulebookHash }), approved.connection_id!);
  const handoff = prepareHandover(f.h, f.owner, 'pneu007', { source_connection_id: 'compatibility-pneu007',
    target_connection_id: approved.connection_id!, expected_epoch: 1, rulebook_hash: rulebookHash, external_access: [] }, []);
  commitHandover(f.h, f.owner, 'pneu007', handoff.id, rulebookHash);
  assert.equal(f.h.identify(token), undefined);
  assert.ok(f.h.identify(issued.access_token));
  provider.gate.resolve();
  await running;
  await receipt(f, intent);
  await f.workflow.reconcile(intent.intent_id);
  assert.equal(provider.starts.length, 1);
  assert.equal(provider.starts[0]!.identifier_from_purchaser, intent.identifier_from_purchaser);
  assert.equal(provider.starts[0]!.input_hash, intent.input_hash);
});
