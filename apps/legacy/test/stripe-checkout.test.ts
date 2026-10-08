import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceSpec } from '../../../packages/contracts/index.js';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { StripeCheckoutWorkflow } from '../src/stripe-checkout.js';

// Deliberately synthetic fixture values, never credentials for a Stripe account.
const env = { STRIPE_SECRET_KEY: 'rk_test_fixtureOnly', STRIPE_ACCOUNT_ID: 'acct_fixtureOnly', STRIPE_WEBHOOK_SECRET: 'whsec_fixtureOnly' };
const actor = { id: 'human-customer-a', customer_id: 'customer-001' };
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
type NativeSession = { object: 'checkout.session'; id: string; livemode: boolean; mode: string; status: string; payment_status: string;
  amount_total: number; currency: string; client_reference_id: string; metadata: Record<string, string>; expires_at: number; created: number;
  url: string | null; payment_intent: string | null };
type NativeIntent = { object: 'payment_intent'; id: string; livemode: boolean; status: string; amount: number; currency: string;
  metadata: Record<string, string>; amount_received: number; last_payment_error: Record<string, unknown> | null };

class MockStripe {
  readonly creates: { body: string; key: string }[] = [];
  readonly sessions = new Map<string, NativeSession>();
  readonly intents = new Map<string, NativeIntent>();
  readonly requests: string[] = [];
  account = env.STRIPE_ACCOUNT_ID;
  accountStatus = 200;
  loseResponse = false;
  failIntentRead = false;
  onCreate?: (session: NativeSession) => void;
  beforeRead?: () => Promise<void>;
  constructor(readonly now: () => Date) {}
  readonly fetch: typeof globalThis.fetch = async (input, options) => {
    const url = String(input);
    this.requests.push(`${options?.method ?? 'GET'} ${url}`);
    assert.equal(new URL(url).origin, 'https://api.stripe.com');
    assert.equal(new Headers(options?.headers).get('Stripe-Version'), '2026-09-30.endive');
    assert.equal(options?.redirect, 'error');
    if (url.endsWith('/account')) return Response.json({ object: 'account', id: this.account }, { status: this.accountStatus });
    if (url.includes('/payment_intents/')) {
      const id = decodeURIComponent(url.split('/payment_intents/')[1]!.split('/')[0]!);
      assert.notEqual(options?.method, 'POST', 'Checkout-owned PaymentIntents must never be directly canceled');
      if (this.failIntentRead) { this.failIntentRead = false; throw new Error('Provider read unavailable'); }
      const intent = this.intents.get(id);
      if (!intent) return Response.json({}, { status: 404 });
      return Response.json(intent);
    }
    if (options?.method === 'POST') {
      const body = String(options.body), key = new Headers(options.headers).get('Idempotency-Key')!;
      const prior = this.creates.find(item => item.key === key);
      if (prior) {
        assert.equal(body, prior.body, 'Retries must preserve every original create parameter');
        return Response.json([...this.sessions.values()][this.creates.indexOf(prior)]);
      }
      this.creates.push({ body, key });
      const params = new URLSearchParams(body), metadata: Record<string, string> = {};
      for (const [name, value] of params) if (name.startsWith('metadata[')) metadata[name.slice(9, -1)] = value;
      const session: NativeSession = { object: 'checkout.session', id: `cs_test_fixture${this.creates.length}`, livemode: false,
        mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
        currency: params.get('line_items[0][price_data][currency]')!, client_reference_id: params.get('client_reference_id')!, metadata,
        expires_at: Number(params.get('expires_at')), created: Math.floor(this.now().getTime() / 1000),
        url: `https://checkout.stripe.com/c/pay/cs_test_fixture${this.creates.length}`, payment_intent: null };
      this.onCreate?.(session);
      this.sessions.set(session.id, session);
      if (this.loseResponse) { this.loseResponse = false; throw new Error('Network response lost after remote session creation'); }
      return Response.json(session);
    }
    await this.beforeRead?.();
    const session = this.sessions.get(decodeURIComponent(url.split('/').at(-1)!));
    return session ? Response.json(session) : Response.json({}, { status: 404 });
  };
  paid(sessionId: string) {
    const session = this.sessions.get(sessionId)!;
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixtureOnly', url: null });
    return session;
  }
  failed(sessionId: string, status = 'requires_payment_method') {
    const session = this.sessions.get(sessionId)!;
    Object.assign(session, { status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_fixtureOnly', url: null });
    const intent: NativeIntent = { object: 'payment_intent', id: session.payment_intent!, livemode: false, status,
      amount: session.amount_total, currency: session.currency, metadata: { ...session.metadata },
      amount_received: 0, last_payment_error: { type: 'card_error', code: 'payment_failed' } };
    this.intents.set(intent.id, intent);
    return { session, intent };
  }
}

function fixture(t: TestContext, configured: NodeJS.ProcessEnv = env) {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-stripe-workflow-')), path = join(dir, 'legacy.sqlite');
  let instant = new Date('2026-10-09T08:00:00.000Z');
  const now = () => instant;
  let store = new LegacyStore(path, { now });
  const remote = new MockStripe(now);
  let workflow = new StripeCheckoutWorkflow(store, { env: configured, publicUrl: 'https://garage.example', fetch: remote.fetch, now });
  t.after(async () => { await workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const quote = store.createQuote({ customer_id: actor.customer_id, service_spec: service, slot_id: 'slot-main' });
  const order = store.createOrder(quote.id);
  return { remote, order, quote, now,
    get store() { return store; }, get workflow() { return workflow; },
    advance(ms: number) { instant = new Date(instant.getTime() + ms); },
    async restart(publicUrl = 'https://garage.example') {
      await workflow.close(); store.close(); store = new LegacyStore(path, { now });
      workflow = new StripeCheckoutWorkflow(store, { env: configured, publicUrl, fetch: remote.fetch, now });
    },
    event(session: NativeSession, type = 'checkout.session.completed', eventId = 'evt_fixtureOnly') {
      const raw = Buffer.from(JSON.stringify({ id: eventId, object: 'event', type, livemode: false, data: { object: session } }));
      const ts = Math.floor(now().getTime() / 1000);
      const digest = createHmac('sha256', configured.STRIPE_WEBHOOK_SECRET!).update(`${ts}.`).update(raw).digest('hex');
      return { raw, signature: `t=${ts},v1=${digest}` };
    },
  };
}
const start = (f: ReturnType<typeof fixture>) => f.workflow.start(f.order.id, actor, { payment_mode: 'deposit', confirm: true });
function records(f: ReturnType<typeof fixture>, table: string) {
  return (f.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE order_id=?`).get(f.order.id) as { n: number }).n;
}

test('missing webhook configuration and live keys keep payment visibly disabled without a hold or API request', async t => {
  const f = fixture(t, { ...env, STRIPE_SECRET_KEY: 'rk_live_forbiddenFixture', STRIPE_WEBHOOK_SECRET: '' });
  assert.equal(f.workflow.status().ready, false);
  assert.deepEqual(f.workflow.status().missing_configuration, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  assert.ok(!JSON.stringify(f.workflow.status()).includes('forbiddenFixture'));
  await assert.rejects(start(f), { code: 'STRIPE_NOT_CONFIGURED' });
  assert.equal(records(f, 'booking_holds'), 0); assert.equal(f.remote.requests.length, 0);
});

test('confirmed human checkout persists its authorization and exact provider parameters before one concurrent dispatch', async t => {
  const f = fixture(t);
  f.remote.onCreate = session => {
    const row = f.store.getStripeCheckout(session.metadata.checkout_id!);
    assert.equal(row.state, 'creating'); assert.ok(row.dispatched_at);
    assert.ok(f.store.db.prepare('SELECT checkout_id FROM stripe_checkout_requests WHERE checkout_id=?').get(row.id));
  };
  const checkouts = await Promise.all(Array.from({ length: 8 }, () => start(f)));
  assert.ok(checkouts.every(checkout => checkout.id === checkouts[0]!.id && checkout.state === 'open'));
  assert.equal(f.remote.creates.length, 1); assert.equal(records(f, 'booking_holds'), 1);
  const checkout = checkouts[0]!, params = new URLSearchParams(f.remote.creates[0]!.body);
  assert.equal(params.get('line_items[0][price_data][currency]'), 'czk');
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), String(checkout.amount_minor));
  assert.equal(params.get('success_url'), `https://garage.example/objednavka/${f.order.id}?link=return`);
  assert.equal(params.get('cancel_url'), `https://garage.example/objednavka/${f.order.id}?link=cancel`);
  assert.equal(params.get('expires_at'), String(Math.floor(f.now().getTime() / 1000) + 1860));
  assert.match(checkout.integration_identifier, /[a-z]{8}$/);
  assert.equal(params.get('client_reference_id'), checkout.id);
  assert.equal(params.get('metadata[customer_id]'), actor.customer_id);
  assert.equal(params.get('payment_intent_data[metadata][checkout_id]'), checkout.id);
  assert.ok([...params.keys()].every(key => !key.includes('payment_method_types')));
  assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
});

test('another customer and unconfirmed requests cannot reserve a slot or dispatch payment', async t => {
  const f = fixture(t);
  await assert.rejects(f.workflow.start(f.order.id, { id: 'human-customer-b', customer_id: 'customer-002' }, { payment_mode: 'deposit', confirm: true }), { code: 'FORBIDDEN' });
  await assert.rejects(f.workflow.start(f.order.id, actor, { payment_mode: 'deposit', confirm: false }), { code: 'PAYMENT_CONFIRMATION_REQUIRED' });
  assert.equal(records(f, 'booking_holds'), 0); assert.equal(f.remote.requests.length, 0);
});

test('official unclaimed sandbox restricted keys work without the unavailable account-read permission', async t => {
  const f = fixture(t, { ...env, STRIPE_SECRET_KEY: 'rkcs_test_fixtureOnly' });
  assert.equal(f.workflow.status().ready, true);
  assert.equal((await start(f)).state, 'open');
  assert.equal(f.remote.requests.some(request => request.endsWith('/account')), false);
});

test('ordinary test keys must belong to the configured account before a session can be created', async t => {
  const f = fixture(t); f.remote.account = 'acct_wrongAccount';
  await assert.rejects(start(f), { code: 'STRIPE_ACCOUNT_MISMATCH' });
  assert.equal(f.remote.creates.length, 0); assert.equal(records(f, 'payments'), 0);
  assert.equal(f.store.getStripeCheckoutForOrder(f.order.id), undefined);
  assert.equal(records(f, 'booking_holds'), 0);
});

test('account verification failure leaves no prepared checkout or slot hold and can be retried safely', async t => {
  const f = fixture(t); f.remote.accountStatus = 403;
  await assert.rejects(start(f), { code: 'STRIPE_API_REJECTED' });
  assert.equal(f.store.getStripeCheckoutForOrder(f.order.id), undefined);
  assert.equal(records(f, 'booking_holds'), 0); assert.equal(f.remote.creates.length, 0);
  f.remote.accountStatus = 200;
  assert.equal((await start(f)).state, 'open');
  assert.equal(records(f, 'booking_holds'), 1); assert.equal(f.remote.creates.length, 1);
});

test('lost create responses recover across restart with the original parameters and idempotency key', async t => {
  const f = fixture(t); f.remote.loseResponse = true;
  await assert.rejects(start(f), { code: 'STRIPE_TEMPORARILY_UNAVAILABLE' });
  const original = f.store.getStripeCheckoutForOrder(f.order.id)!;
  assert.equal(original.state, 'creating'); assert.equal(original.session_id, null);
  const saved = f.remote.creates[0]!;
  f.advance(240_000); await f.restart('https://changed-deployment.example');
  const recovered = await start(f);
  assert.equal(recovered.session_id, 'cs_test_fixture1'); assert.equal(recovered.id, original.id);
  assert.equal(recovered.dispatched_at, original.dispatched_at); assert.equal(f.remote.creates.length, 1);
  assert.equal((f.store.db.prepare('SELECT form_body FROM stripe_checkout_requests WHERE checkout_id=?').get(original.id) as { form_body: string }).form_body, saved.body);
  assert.equal(records(f, 'payments'), 0);
});

test('uncertain creates are never replayed beyond the conservative idempotency retention window', async t => {
  const f = fixture(t); f.remote.loseResponse = true;
  await assert.rejects(start(f));
  const checkout = f.store.getStripeCheckoutForOrder(f.order.id)!;
  f.advance(23 * 3600_000); await f.restart();
  await assert.rejects(f.workflow.reconcile(checkout.id), { code: 'STRIPE_IDEMPOTENCY_WINDOW_EXCEEDED' });
  assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1);
  assert.equal(f.store.getStripeCheckout(checkout.id).session_id, null);
  assert.equal(records(f, 'payments'), 0);
});

test('signed completed events retrieve authoritative sessions and fulfill paid checkout once across duplicate delivery', async t => {
  const f = fixture(t), checkout = await start(f);
  const stale = structuredClone(f.remote.sessions.get(checkout.session_id!)!);
  f.remote.paid(checkout.session_id!);
  const event = f.event(stale);
  assert.deepEqual(await f.workflow.webhook(event.raw, event.signature), { received: true, handled: true });
  const reads = f.remote.requests.length;
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.remote.requests.length, reads);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'paid');
  assert.equal(records(f, 'payments'), 1); assert.equal(records(f, 'bookings'), 1);
  const payment = f.store.db.prepare('SELECT state FROM payments WHERE order_id=?').get(f.order.id) as { state: string };
  assert.equal(payment.state, 'paid');
});

test('completed unpaid events wait for verified async success; failure notifications never imply a paid booking', async t => {
  const f = fixture(t), checkout = await start(f), session = f.remote.sessions.get(checkout.session_id!)!;
  Object.assign(session, { status: 'complete', url: null });
  const completed = f.event(session, 'checkout.session.completed', 'evt_completed');
  await f.workflow.webhook(completed.raw, completed.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'processing'); assert.equal(records(f, 'payments'), 0);
  f.remote.failed(checkout.session_id!, 'processing');
  const failed = f.event(session, 'checkout.session.async_payment_failed', 'evt_failed');
  await assert.rejects(f.workflow.webhook(failed.raw, failed.signature), { code: 'STRIPE_PAYMENT_FAILURE_UNCONFIRMED' });
  assert.equal(records(f, 'bookings'), 0);
  f.remote.paid(checkout.session_id!);
  const paid = f.event(session, 'checkout.session.async_payment_succeeded', 'evt_paid');
  await f.workflow.webhook(paid.raw, paid.signature);
  assert.equal(records(f, 'payments'), 1); assert.equal(records(f, 'bookings'), 1);
});

test('signed terminal async failure corroborated by its failed test intent releases the hold without cancellation API calls', async t => {
  const f = fixture(t), checkout = await start(f), { session } = f.remote.failed(checkout.session_id!);
  const event = f.event(session, 'checkout.session.async_payment_failed', 'evt_failed');
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'failed');
  assert.equal((f.store.db.prepare('SELECT status FROM booking_holds WHERE id=?').get(checkout.hold_id) as { status: string }).status, 'released');
  assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1);
  assert.equal(f.remote.requests.filter(request => request === 'GET https://api.stripe.com/v1/payment_intents/pi_fixtureOnly').length, 1);
  const audit = f.store.db.prepare("SELECT data_json FROM audit_events WHERE entity_id=? AND event_type='provider_payment_failed'").get(checkout.id) as { data_json: string } | undefined;
  assert.ok(audit?.data_json.includes('evt_failed'));
  const requests = f.remote.requests.length;
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.remote.requests.length, requests);
  assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
  assert.equal((await start(f)).id, checkout.id); assert.equal(f.remote.creates.length, 1);
});

test('failed intent reads preserve the reservation and recover across restart without provider mutations', async t => {
  const f = fixture(t), checkout = await start(f), { session } = f.remote.failed(checkout.session_id!);
  f.remote.failIntentRead = true;
  const event = f.event(session, 'checkout.session.async_payment_failed', 'evt_failed');
  await assert.rejects(f.workflow.webhook(event.raw, event.signature), { code: 'STRIPE_TEMPORARILY_UNAVAILABLE' });
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'reconciliation_required');
  await f.restart();
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'failed');
  assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1); assert.equal(f.remote.creates.length, 1);
  assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
});

test('an already canceled matching intent is accepted without any cancellation request', async t => {
  const f = fixture(t), checkout = await start(f), { session, intent } = f.remote.failed(checkout.session_id!, 'canceled');
  intent.last_payment_error = null;
  const event = f.event(session, 'checkout.session.async_payment_failed', 'evt_alreadyCanceled');
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'failed');
  assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1);
  assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
});

test('read-only polling never treats an unsigned completed-unpaid session as terminal failure', async t => {
  const f = fixture(t), checkout = await start(f);
  f.remote.failed(checkout.session_id!);
  assert.equal((await f.workflow.reconcile(checkout.id)).state, 'processing');
  assert.equal(f.remote.requests.some(request => request.includes('/payment_intents/')), false);
  assert.ok(!f.store.availability().some(slot => slot.id === f.quote.slot_id));
  assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
});

test('failed checkout remains terminal across restart; late actual payment is recorded for reconciliation without a booking', async t => {
  const f = fixture(t), checkout = await start(f), { session } = f.remote.failed(checkout.session_id!);
  const failed = f.event(session, 'checkout.session.async_payment_failed', 'evt_failed');
  await f.workflow.webhook(failed.raw, failed.signature);
  await f.restart();
  const requests = f.remote.requests.length;
  assert.equal((await f.workflow.reconcile(checkout.id)).state, 'failed');
  f.workflow.startBackground(5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.remote.requests.length, requests);
  f.remote.paid(checkout.session_id!);
  const paid = f.event(session, 'checkout.session.async_payment_succeeded', 'evt_latePaid');
  await f.workflow.webhook(paid.raw, paid.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'reconciliation_required');
  assert.equal(records(f, 'payments'), 1); assert.equal(records(f, 'bookings'), 0);
  await f.workflow.reconcile(checkout.id);
  assert.equal(records(f, 'payments'), 1); assert.equal(records(f, 'bookings'), 0);
  assert.ok(f.store.availability().some(slot => slot.id === f.quote.slot_id));
});

test('failed events with mismatched, live, processing or action-required intents cannot release a hold or cancel', async t => {
  const changes: [string, (intent: NativeIntent) => void][] = [
    ['identity', intent => { intent.id = 'pi_other'; }],
    ['amount', intent => { intent.amount++; }],
    ['currency', intent => { intent.currency = 'eur'; }],
    ['live', intent => { intent.livemode = true; }],
    ['customer', intent => { intent.metadata.customer_id = 'customer-002'; }],
    ['processing', intent => { intent.status = 'processing'; }],
    ['action', intent => { intent.status = 'requires_action'; }],
    ['confirmation', intent => { intent.status = 'requires_confirmation'; }],
    ['succeeded', intent => { intent.status = 'succeeded'; }],
    ['funds received', intent => { intent.amount_received = 100; }],
    ['missing failure', intent => { intent.last_payment_error = null; }],
  ];
  for (const [name, change] of changes) await t.test(name, async nested => {
    const f = fixture(nested), checkout = await start(f), { session, intent } = f.remote.failed(checkout.session_id!);
    change(intent);
    const event = f.event(session, 'checkout.session.async_payment_failed', 'evt_failed');
    await assert.rejects(f.workflow.webhook(event.raw, event.signature));
    assert.equal(f.store.getStripeCheckout(checkout.id).state, 'reconciliation_required');
    assert.equal((f.store.db.prepare('SELECT status FROM booking_holds WHERE id=?').get(checkout.hold_id) as { status: string }).status, 'reconciliation');
    assert.ok(!f.store.availability().some(slot => slot.id === f.quote.slot_id));
    assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1); assert.equal(f.remote.creates.length, 1);
    assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
  });
});

test('a verified expired session releases its hold and cannot be replaced for the same order', async t => {
  const f = fixture(t), checkout = await start(f), session = f.remote.sessions.get(checkout.session_id!)!;
  f.advance(1860_000); Object.assign(session, { status: 'expired', url: null });
  const event = f.event(session, 'checkout.session.expired');
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'expired');
  assert.equal((f.store.db.prepare('SELECT status FROM booking_holds WHERE id=?').get(checkout.hold_id) as { status: string }).status, 'released');
  assert.equal((await start(f)).id, checkout.id); assert.equal(f.remote.creates.length, 1);
  assert.equal(records(f, 'payments'), 0);
});

test('tampered, replayed, future and live webhook payloads fail before provider retrieval', async t => {
  const f = fixture(t), checkout = await start(f), event = f.event(f.remote.sessions.get(checkout.session_id!)!);
  const reads = f.remote.requests.length;
  await assert.rejects(f.workflow.webhook(Buffer.concat([event.raw, Buffer.from(' ')]), event.signature), { code: 'STRIPE_WEBHOOK_INVALID' });
  await assert.rejects(f.workflow.webhook(event.raw, event.signature.replace(/v1=.*/, `v1=${'0'.repeat(64)}`)), { code: 'STRIPE_WEBHOOK_INVALID' });
  f.advance(301_000);
  await assert.rejects(f.workflow.webhook(event.raw, event.signature), { code: 'STRIPE_WEBHOOK_INVALID' });
  f.advance(-602_000);
  await assert.rejects(f.workflow.webhook(event.raw, event.signature), { code: 'STRIPE_WEBHOOK_INVALID' });
  f.advance(301_000);
  for (const override of [{ livemode: true }, { account: 'acct_wrongAccount' }]) {
    const raw = Buffer.from(JSON.stringify({ ...JSON.parse(event.raw.toString('utf8')), ...override }));
    const ts = Math.floor(f.now().getTime() / 1000);
    const digest = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${ts}.`).update(raw).digest('hex');
    await assert.rejects(f.workflow.webhook(raw, `t=${ts},v1=${digest}`), { code: 'STRIPE_WEBHOOK_INVALID' });
  }
  assert.equal(f.remote.requests.length, reads); assert.equal(records(f, 'payments'), 0);
});

test('a webhook recovers a paid session after its original create response was lost without creating another session', async t => {
  const f = fixture(t); f.remote.loseResponse = true;
  await assert.rejects(start(f));
  const session = f.remote.paid('cs_test_fixture1'), event = f.event(session);
  await f.restart();
  await f.workflow.webhook(event.raw, event.signature);
  assert.equal(f.remote.requests.filter(request => request.startsWith('POST')).length, 1);
  assert.equal(records(f, 'payments'), 1); assert.equal(records(f, 'bookings'), 1);
});

test('fetched sessions with changed price, customer, quote, currency, live mode or checkout origin cannot fulfill', async t => {
  const changes: [string, (session: NativeSession) => void][] = [
    ['price', session => { session.amount_total++; }],
    ['customer', session => { session.metadata.customer_id = 'customer-002'; }],
    ['quote', session => { session.metadata.quote_version = '999'; }],
    ['currency', session => { session.currency = 'eur'; }],
    ['live mode', session => { session.livemode = true; }],
    ['checkout origin', session => { session.url = 'https://checkout.stripe.com.evil.example/c/pay/fake'; }],
    ['payment intent', session => { session.payment_intent = 'unsafe'; }],
    ['missing paid intent', session => { session.payment_intent = null; }],
    ['session identity', session => { session.id = 'cs_test_other'; }],
  ];
  for (const [name, change] of changes) await t.test(name, async nested => {
    const f = fixture(nested), checkout = await start(f), session = f.remote.paid(checkout.session_id!);
    change(session);
    await assert.rejects(f.workflow.reconcile(checkout.id));
    assert.equal(f.store.getStripeCheckout(checkout.id).state, 'reconciliation_required');
    assert.equal(records(f, 'payments'), 0); assert.equal(records(f, 'bookings'), 0);
  });
});

test('background observation is non-overlapping and never retries an uncertain creation', async t => {
  const uncertain = fixture(t); uncertain.remote.loseResponse = true;
  await assert.rejects(start(uncertain));
  uncertain.workflow.startBackground(5);
  await new Promise(resolve => setTimeout(resolve, 25));
  await uncertain.workflow.close();
  assert.equal(uncertain.remote.requests.filter(request => request.startsWith('POST')).length, 1);

  const f = fixture(t), checkout = await start(f);
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.remote.beforeRead = async () => { reads++; await gate; };
  f.workflow.startBackground(5);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(reads, 1);
  release(); await f.workflow.close();
  assert.equal(f.store.getStripeCheckout(checkout.id).state, 'open');
});
