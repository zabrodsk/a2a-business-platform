import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessError, type PaymentObservation, type PaymentProvider, type PaymentRequest, type PurchaseAuthorization, type ServiceSpec } from '../../../packages/contracts/index.js';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { LocalDemoProvider, MasumiProvider, selectPaymentSku } from '../../../packages/payments/index.js';
import { PaymentWorkflow } from '../src/payment-workflow.js';

const clock = () => new Date('2026-10-08T08:00:00.000Z');
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
async function fixture(t: TestContext, provider: PaymentProvider = new LocalDemoProvider({ now: clock })) {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-payment-workflow-'));
  const path = join(dir, 'legacy.sqlite');
  let store = new LegacyStore(path, { now: clock });
  let processor = new PaymentWorkflow(store, provider);
  t.after(async () => { await processor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get processor() { return processor; },
    async restart() { await processor.close(); store.close(); store = new LegacyStore(path, { now: clock }); processor = new PaymentWorkflow(store, provider); },
  };
}
function checkout(store: LegacyStore, provider: 'local_demo' | 'masumi' = 'local_demo') {
  const quote = store.createQuote({ customer_id: 'customer-001', service_spec: service, slot_id: 'slot-main' });
  const order = store.createOrder(quote.id);
  const mapping = selectPaymentSku({ payment_mode: 'deposit', amount_minor: 50000, max_network_fee: '2000000', network: provider === 'masumi' ? 'Preprod' : 'local' }, { MASUMI_SELLER_VKEY: 'a'.repeat(64) });
  const authorization: PurchaseAuthorization = { kind: 'human_checkout', actor_id: 'human-customer-a', customer_id: order.customer_id,
    quote_id: quote.id, quote_version: quote.version, payment_mode: 'deposit', max_total_minor: quote.price.total_minor,
    max_deposit_minor: 50000, network: mapping.network, seller_id: mapping.seller_id, asset: mapping.asset,
    asset_quantity: mapping.asset_quantity, max_network_fee: mapping.max_network_fee, mapping_version: mapping.mapping_version,
    approved_at: clock().toISOString() };
  return store.prepareCheckout(order.id, { authorization, provider, ...mapping });
}
function count(store: LegacyStore, table: 'payments' | 'bookings' | 'booking_holds' | 'ledger_entries', clause: string, id: string) {
  return (store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${clause}=?`).get(id) as { n: number }).n;
}

/** Simulated remote provider state survives local DB restarts; faults model lost HTTP responses. */
class InterruptedProvider implements PaymentProvider {
  readonly name = 'local_demo' as const;
  readonly local = new LocalDemoProvider({ now: clock });
  readonly remote = new Map<string, PaymentObservation>();
  readonly submitted: string[] = [];
  starts = 0;
  observes = 0;
  refunds = 0;
  throwStart = false;
  throwResult = false;
  async start(request: PaymentRequest) {
    this.starts++;
    const response = await this.local.start(request); this.remote.set(request.intent_id, response);
    if (this.throwStart) { this.throwStart = false; throw new BusinessError('PROVIDER_RESPONSE_LOST', 'Remote funding occurred but response was lost', 503); }
    return response;
  }
  async observe(request: PaymentRequest, previous?: PaymentObservation) {
    this.observes++;
    const prior = this.remote.get(request.intent_id) ?? previous;
    assert.ok(prior, 'Recovery must resolve the original remote transaction, not create a replacement purchase');
    const response = await this.local.observe(request, prior); this.remote.set(request.intent_id, response);
    return response;
  }
  async submitResult(request: PaymentRequest, previous: PaymentObservation, hash: string) {
    this.submitted.push(hash);
    const response = await this.local.submitResult(request, previous, hash); this.remote.set(request.intent_id, response);
    if (this.throwResult) { this.throwResult = false; throw new BusinessError('PROVIDER_RESULT_RESPONSE_LOST', 'Result acknowledgement lost', 503); }
    return response;
  }
  async requestRefund(request: PaymentRequest, previous: PaymentObservation) {
    this.refunds++;
    const response = await this.local.requestRefund(request, previous); this.remote.set(request.intent_id, response);
    return response;
  }
}

test('delayed funding keeps the slot held until verified observation confirms a single booking', async t => {
  const f = await fixture(t, new LocalDemoProvider({ now: clock, scenario: 'delayed', delayObservations: 2 }));
  const intent = checkout(f.store);
  const first = await f.processor.reconcile(intent.intent_id);
  assert.equal(first.state, 'purchase_requested'); assert.equal(f.store.getOrder(intent.order_id).status, 'awaiting_payment');
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 0);
  assert.ok(!f.store.availability().some(slot => slot.id === 'slot-main'));
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'purchase_requested');
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'result_submitted');
  assert.equal(f.store.getOrder(intent.order_id).status, 'confirmed');
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 1);
  assert.equal(count(f.store, 'payments', 'intent_id', intent.intent_id), 1);
});

test('lost funding response is persisted and recovered after restart without a second purchase dispatch', async t => {
  const provider = new InterruptedProvider(); provider.throwStart = true;
  const f = await fixture(t, provider), intent = checkout(f.store);
  const uncertain = await f.processor.reconcile(intent.intent_id);
  assert.equal(uncertain.state, 'purchase_requested'); assert.equal(uncertain.observation, undefined);
  assert.equal((f.processor.error(intent.intent_id) as { code: string }).code, 'PROVIDER_RESPONSE_LOST');
  assert.equal(count(f.store, 'payments', 'intent_id', intent.intent_id), 0);
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 0);
  assert.ok(!f.store.availability().some(slot => slot.id === 'slot-main'));
  await f.restart();
  assert.equal((f.processor.error(intent.intent_id) as { code: string }).code, 'PROVIDER_RESPONSE_LOST');
  const recovered = await f.processor.reconcile(intent.intent_id);
  assert.equal(recovered.state, 'result_submitted'); assert.equal(provider.starts, 1); assert.equal(provider.observes, 1);
  assert.equal(f.processor.error(intent.intent_id), undefined);
  assert.equal(f.store.getOrder(intent.order_id).status, 'confirmed');
  assert.equal(recovered.identifier_from_purchaser, intent.identifier_from_purchaser);
  assert.equal(recovered.input_hash, intent.input_hash);
  assert.equal(count(f.store, 'payments', 'intent_id', intent.intent_id), 1);
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 1);
});

test('voucher survives lost result response and restart with the same SHA-256 commitment', async t => {
  const provider = new InterruptedProvider(); provider.throwResult = true;
  const f = await fixture(t, provider), intent = checkout(f.store);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'escrow_funded');
  const receipt = f.processor.getReceipt(intent.intent_id)!;
  const expected = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  assert.equal(provider.submitted[0], expected);
  await f.restart();
  assert.deepEqual(f.processor.getReceipt(intent.intent_id), receipt);
  const recovered = await f.processor.reconcile(intent.intent_id);
  assert.equal(recovered.state, 'seller_paid');
  assert.equal((recovered.observation!.raw as { result_hash: string }).result_hash, expected);
  assert.equal(provider.starts, 1); assert.equal(provider.submitted.length, 1);
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 1);
});

test('concurrent and repeated reconciliation never duplicate checkout, booking, funding or settlement', async t => {
  const provider = new InterruptedProvider();
  const f = await fixture(t, provider), intent = checkout(f.store);
  await Promise.all(Array.from({ length: 8 }, () => f.processor.reconcile(intent.intent_id)));
  await f.processor.reconcile(intent.intent_id);
  await f.processor.reconcile(intent.intent_id);
  assert.equal(provider.starts, 1); assert.equal(provider.submitted.length, 1);
  assert.equal(f.store.getPaymentIntent(intent.intent_id).state, 'seller_paid');
  assert.equal(count(f.store, 'booking_holds', 'order_id', intent.order_id), 1);
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 1);
  assert.equal(count(f.store, 'payments', 'intent_id', intent.intent_id), 1);
  const payment = f.store.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intent.intent_id) as { id: string };
  const ledger = f.store.db.prepare('SELECT kind FROM ledger_entries WHERE payment_id=? ORDER BY kind').all(payment.id);
  assert.deepEqual(ledger, [{ kind: 'escrow_funded' }, { kind: 'settled' }]);
  const persisted = f.store.prepareCheckout(intent.order_id, { authorization: intent.authorization, provider: intent.provider,
    sku: intent.sku, asset_quantity: intent.asset_quantity, max_network_fee: intent.max_network_fee, seller_id: intent.seller_id });
  assert.equal(persisted.intent_id, intent.intent_id);
});

test('unconfigured Masumi persists a configuration error without fabricating remote identifiers or confirmations', async t => {
  const f = await fixture(t, new MasumiProvider(undefined)), intent = checkout(f.store, 'masumi');
  const result = await f.processor.reconcile(intent.intent_id);
  assert.equal(result.provider, 'masumi'); assert.equal(result.state, 'purchase_requested');
  assert.equal(result.observation, undefined);
  assert.equal((f.processor.error(intent.intent_id) as { code: string }).code, 'MASUMI_NOT_CONFIGURED');
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 0);
  assert.equal(count(f.store, 'payments', 'intent_id', intent.intent_id), 0);
  await f.restart();
  assert.equal((f.processor.error(intent.intent_id) as { code: string }).code, 'MASUMI_NOT_CONFIGURED');
  assert.equal((await f.processor.reconcile(intent.intent_id)).observation, undefined);
});

test('refund is confirmed only by provider observation and repeated reconciliation records one reversal', async t => {
  const f = await fixture(t), intent = checkout(f.store);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'result_submitted');
  f.store.cancelOrder(intent.order_id, 'staff-owner');
  assert.equal((await f.processor.requestRefund(intent.intent_id)).state, 'refund_requested');
  assert.equal(f.store.getOrder(intent.order_id).status, 'refund_pending');
  assert.equal((await f.processor.requestRefund(intent.intent_id)).state, 'refund_requested');
  await f.processor.reconcile(intent.intent_id);
  assert.equal(f.store.getOrder(intent.order_id).status, 'refunded');
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'refunded');
  assert.equal((await f.processor.requestRefund(intent.intent_id)).state, 'refunded');
  const payment = f.store.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intent.intent_id) as { id: string };
  const refunds = f.store.db.prepare("SELECT amount_minor FROM ledger_entries WHERE payment_id=? AND kind='refund'").all(payment.id);
  assert.deepEqual(refunds, [{ amount_minor: -50000 }]);
  assert.equal(f.store.calendar('customer-001').find(booking => booking.order_id === intent.order_id)!.status, 'cancelled');
});


test('cancelled uncertain purchase automatically refunds late funding without creating a booking', async t => {
  const provider = new InterruptedProvider(); provider.throwStart = true;
  const f = await fixture(t, provider), intent = checkout(f.store);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'purchase_requested');
  assert.equal(f.store.cancelOrder(intent.order_id, 'staff-owner').status, 'cancel_requested');
  await f.restart();
  const late = await f.processor.reconcile(intent.intent_id);
  assert.equal(late.state, 'refund_requested');
  assert.equal(f.store.getOrder(intent.order_id).status, 'refund_pending');
  assert.equal(provider.starts, 1); assert.equal(provider.refunds, 1);
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 0);
  assert.equal(f.processor.getReceipt(intent.intent_id), undefined);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'refunded');
  assert.equal(f.store.getOrder(intent.order_id).status, 'refunded');
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 0);
  assert.equal(provider.refunds, 1);
});

test('overlapping refund requests dispatch one provider refund and keep reconciliation serialized', async t => {
  const provider = new InterruptedProvider();
  const f = await fixture(t, provider), intent = checkout(f.store);
  await f.processor.reconcile(intent.intent_id);
  f.store.cancelOrder(intent.order_id, 'staff-owner');
  const refunds = Array.from({ length: 8 }, () => f.processor.requestRefund(intent.intent_id));
  const concurrentObservation = f.processor.reconcile(intent.intent_id);
  const results = await Promise.all([...refunds, concurrentObservation]);
  assert.ok(results.every(result => result.state === 'refund_requested'));
  assert.equal(provider.refunds, 1);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'refunded');
  const payment = f.store.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intent.intent_id) as { id: string };
  const reversals = f.store.db.prepare("SELECT amount_minor FROM ledger_entries WHERE payment_id=? AND kind='refund'").all(payment.id);
  assert.deepEqual(reversals, [{ amount_minor: -50000 }]);
});

test('settled purchase requires explicit manual compensation and never pretends escrow was refunded', async t => {
  const provider = new InterruptedProvider();
  const f = await fixture(t, provider), intent = checkout(f.store);
  await f.processor.reconcile(intent.intent_id);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'seller_paid');
  f.store.cancelOrder(intent.order_id, 'staff-owner');
  await assert.rejects(f.processor.requestRefund(intent.intent_id), { code: 'MANUAL_COMPENSATION_REQUIRED', status: 409 });
  assert.equal(provider.refunds, 0);
  assert.equal(f.store.getPaymentIntent(intent.intent_id).state, 'seller_paid');
  assert.equal(f.store.getOrder(intent.order_id).status, 'refund_pending');
});


test('refund queued during a running funding operation waits for proof and dispatches once', async t => {
  let releaseStart!: () => void;
  const gate = new Promise<void>(resolve => { releaseStart = resolve; });
  class BlockedStartProvider extends InterruptedProvider {
    async start(request: PaymentRequest) { await gate; return super.start(request); }
  }
  const provider = new BlockedStartProvider();
  const f = await fixture(t, provider), intent = checkout(f.store);
  const funding = f.processor.reconcile(intent.intent_id);
  assert.equal(f.store.getPaymentIntent(intent.intent_id).state, 'purchase_requested');
  const refunds = Array.from({ length: 5 }, () => f.processor.requestRefund(intent.intent_id));
  assert.equal(provider.refunds, 0);
  releaseStart();
  assert.equal((await funding).state, 'result_submitted');
  const results = await Promise.all(refunds);
  assert.ok(results.every(result => result.state === 'refund_requested'));
  assert.equal(provider.starts, 1); assert.equal(provider.refunds, 1);
  assert.equal((await f.processor.reconcile(intent.intent_id)).state, 'refunded');
});


test('concurrent owner resumes use the original nonce and remote escrow exactly once', async t => {
  class ResumableProvider extends InterruptedProvider {
    resumes: Array<{ nonce: string; input: string; providerId: string }> = [];
    async resumePurchase(request: PaymentRequest, previous?: PaymentObservation) {
      const remote = this.remote.get(request.intent_id);
      assert.ok(remote?.provider_payment_id);
      this.resumes.push({ nonce: request.identifier_from_purchaser, input: request.input_hash, providerId: remote.provider_payment_id });
      assert.equal(previous, undefined);
      return remote;
    }
  }
  const provider = new ResumableProvider(); provider.throwStart = true;
  const f = await fixture(t, provider), intent = checkout(f.store);
  await f.processor.reconcile(intent.intent_id);
  await f.restart();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.processor.ownerOperation(intent.intent_id, 'resume')));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'RESUME_FORBIDDEN');
  assert.deepEqual(provider.resumes, [{ nonce: intent.identifier_from_purchaser, input: intent.input_hash, providerId: provider.remote.get(intent.intent_id)!.provider_payment_id }]);
  assert.equal(provider.starts, 1); assert.equal(f.store.listPaymentIntents().length, 1);
  assert.equal(f.store.getOrder(intent.order_id).status, 'confirmed');
  assert.equal(count(f.store, 'bookings', 'order_id', intent.order_id), 1);
});

test('owner cannot resume a cancelled uncertain purchase or authorize a refund before a verified request', async t => {
  class ResumableProvider extends InterruptedProvider {
    resumes = 0;
    authorizations = 0;
    async resumePurchase(request: PaymentRequest) { this.resumes++; return this.local.start(request); }
    async authorizeRefund(request: PaymentRequest, previous: PaymentObservation) { this.authorizations++; return this.local.observe(request, previous); }
  }
  const provider = new ResumableProvider(); provider.throwStart = true;
  const f = await fixture(t, provider), intent = checkout(f.store);
  await f.processor.reconcile(intent.intent_id);
  f.store.cancelOrder(intent.order_id, 'staff-owner');
  await assert.rejects(f.processor.ownerOperation(intent.intent_id, 'resume'), { code: 'RESUME_FORBIDDEN', status: 409 });
  await assert.rejects(f.processor.ownerOperation(intent.intent_id, 'authorize_refund'), { code: 'REFUND_AUTHORIZATION_UNAVAILABLE', status: 409 });
  assert.equal(provider.resumes, 0); assert.equal(provider.authorizations, 0);
});
