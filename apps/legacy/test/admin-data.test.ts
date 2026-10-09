import test from 'node:test';
import assert from 'node:assert/strict';
import { availableOrderActions, dayLabel, matchesSearch, moneyLabel, orderOf, orderStatus, paymentStatus, pragueDay, serviceLabel, shortReference, timeLabel, vehicleLabel } from '../public/admin-data.js';

const now = Date.parse('2026-10-09T10:00:00Z');
const record = (state: string, provider = 'masumi', orderStatus = 'confirmed') => ({
  order: { id: 'order-test-007', status: orderStatus },
  intent: { provider, state, observation: { state } },
  booking: { status: 'confirmed', start_at: '2026-10-12T08:00:00Z' },
});
const actions = (value: unknown, role: string) => availableOrderActions(value, role, now).map(value => value.action);

test('reservation, service completion and provider funding are separate statuses', () => {
  assert.equal(orderStatus(record('escrow_funded')).label, 'Rezervace potvrzena');
  assert.equal(orderStatus(record('escrow_funded', 'masumi', 'service_completed')).label, 'Služba dokončena');
  assert.equal(paymentStatus(record('escrow_funded')).label, 'Prostředky v úschově');
  assert.equal(paymentStatus(record('result_submitted')).label, 'Čeká na vyplacení');
  assert.equal(paymentStatus(record('seller_paid')).label, 'Vyplaceno firmě');
  assert.match(paymentStatus(record('seller_paid')).note, /kompenzací/);
  assert.notEqual(paymentStatus(record('refund_requested')).label, paymentStatus(record('refunded')).label);
});

test('uncertain or unobserved funding does not display a successful payment', () => {
  const value = record('reconciliation_required');
  value.intent.observation.state = 'escrow_funded';
  assert.equal(paymentStatus(value).tone, 'warn');
  assert.match(paymentStatus(value).note, /Novou platbu nezahajujte/);
  assert.equal(paymentStatus({ intent: { state: 'seller_paid' } }).tone, 'warn');
  assert.equal(paymentStatus({ order: { status: 'confirmed' } }).label, 'Platba neevidována');
  assert.equal(paymentStatus({ intent: { state: 'new_provider_state' } }).label, 'Neznámý platební stav');
});

test('fixture amounts and simulations never become current live payment confirmations', () => {
  const fixture = paymentStatus({ origin: 'fixture', amount_minor: 50000, status: 'service_completed' });
  assert.match(fixture.label, /Importovaná evidence/);
  assert.match(fixture.note, /není potvrzením aktuální platby/);
  assert.equal(paymentStatus({ origin: 'fixture', amount_minor: null, status: 'confirmed' }).label, 'Platba neevidována');
  assert.match(paymentStatus(record('escrow_funded', 'local_demo')).note, /Lokální simulace/);
  assert.match(paymentStatus({ stripe_checkout: { state: 'paid' } }).note, /testovací režim/);
});

test('customer and agent roles never receive administrative operations', () => {
  for (const role of ['human_customer', 'business_agent', 'customer_agent', 'owner_agent', 'unclaimed_agent', '']) {
    assert.deepEqual(actions(record('escrow_funded'), role), []);
  }
});

test('funded refund actions require owner and replace generic cancellation', () => {
  assert.deepEqual(actions(record('escrow_funded'), 'staff'), ['reschedule']);
  assert.deepEqual(actions(record('escrow_funded'), 'owner'), ['reschedule', 'refund-request']);
  assert.deepEqual(actions(record('seller_paid'), 'owner'), ['reschedule']);
  assert.deepEqual(actions(record('refund_requested', 'masumi', 'refund_pending'), 'owner'), ['authorize-refund']);
  assert.deepEqual(actions(record('refund_requested', 'masumi', 'refund_pending'), 'staff'), []);
  const stale = record('refunded', 'masumi', 'refunded');
  stale.intent.observation.state = 'refund_requested';
  assert.deepEqual(actions(stale, 'owner'), []);
});

test('only unresolved Masumi purchases can be resumed and cancellation prevents resuming', () => {
  assert.ok(actions(record('purchase_requested', 'masumi', 'awaiting_payment'), 'owner').includes('resume-payment'));
  assert.ok(!actions(record('purchase_requested', 'masumi', 'awaiting_payment'), 'staff').includes('resume-payment'));
  assert.ok(!actions(record('purchase_requested', 'local_demo', 'awaiting_payment'), 'owner').includes('resume-payment'));
  for (const orderState of ['cancel_requested', 'cancelled', 'refund_pending', 'refunded', 'service_completed', 'expired']) {
    assert.ok(!actions(record('reconciliation_required', 'masumi', orderState), 'owner').includes('resume-payment'));
  }
  assert.equal(availableOrderActions(record('purchase_requested', 'masumi', 'awaiting_payment'), 'staff', now).find(value => value.action === 'cancel')?.label, 'Požádat o storno');
});

test('active and paid Stripe checkouts cannot be cancelled through unsupported APIs', () => {
  for (const state of ['prepared', 'creating', 'open', 'processing', 'paid', 'reconciliation_required']) {
    const value = { order: { id: 'order-stripe', status: 'awaiting_payment' }, stripe_checkout: { state } };
    assert.deepEqual(actions(value, 'owner'), []);
    assert.deepEqual(actions(value, 'staff'), []);
  }
  for (const state of ['expired', 'failed']) {
    assert.deepEqual(actions({ order: { id: 'order-stripe', status: 'payment_failed' }, stripe_checkout: { state } }, 'staff'), ['cancel']);
  }
});

test('rescheduling requires a confirmed future booking and an active order', () => {
  assert.ok(actions(record('created'), 'staff').includes('reschedule'));
  const past = record('created'); past.booking.start_at = '2026-10-08T08:00:00Z';
  assert.ok(!actions(past, 'staff').includes('reschedule'));
  const cancelled = record('created'); cancelled.booking.status = 'cancelled';
  assert.ok(!actions(cancelled, 'staff').includes('reschedule'));
  for (const state of ['service_completed', 'cancelled', 'refunded', 'refund_pending', 'cancel_requested', 'expired']) {
    assert.ok(!actions(record('created', 'masumi', state), 'staff').includes('reschedule'));
  }
});

test('Prague labels account for midnight and both daylight saving boundaries', () => {
  assert.equal(pragueDay('2026-10-09T22:30:00Z'), '2026-10-10');
  assert.equal(timeLabel('2026-03-29T00:30:00Z'), '01:30');
  assert.equal(timeLabel('2026-03-29T01:30:00Z'), '03:30');
  assert.equal(timeLabel('2026-10-25T00:30:00Z'), '02:30');
  assert.equal(timeLabel('2026-10-25T01:30:00Z'), '02:30');
  assert.equal(pragueDay('2026-12-01T23:30:00Z'), '2026-12-02');
  assert.match(dayLabel('2026-10-09T22:30:00Z'), /10\. 10\. 2026/);
});

test('missing values stay honest while names and references remain readable', () => {
  for (const value of [null, undefined, '', 'not a date', false, Symbol('invalid'), {}, []]) {
    if (value !== undefined) assert.equal(pragueDay(value), '');
    assert.equal(dayLabel(value), 'Neuvedeno'); assert.equal(timeLabel(value), 'Neuvedeno');
  }
  for (const value of [null, undefined, '', NaN, Infinity, '50000']) assert.equal(moneyLabel(value), 'Neuvedeno');
  assert.match(moneyLabel(50000), /500/); assert.match(moneyLabel(0), /0/);
  assert.deepEqual(orderOf(null), {}); assert.deepEqual(availableOrderActions(null, 'owner'), []);
  assert.equal(orderStatus({ status: 'unexpected' }).tone, 'neutral');
  assert.equal(orderStatus({ status: '__proto__' }).tone, 'neutral');
  assert.equal(paymentStatus({ stripe_checkout: { state: 'toString' } }).label, 'Neznámý platební stav');
  assert.equal(serviceLabel(undefined), 'Služba neuvedena'); assert.equal(vehicleLabel({}), 'Vozidlo neuvedeno');
  assert.equal(serviceLabel({ service_id: 'wheel_swap' }), 'Výměna celých kol');
  assert.equal(vehicleLabel({ vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu' }), 'Osobní · 18″ · alu disky');
  assert.equal(shortReference('order-fixture-001'), 'OBJ 001'); assert.equal(shortReference(null), 'Neuvedeno');
  assert.ok(matchesSearch('sarka novakova', ['Šárka Nováková', 'sarka@example.com']));
  assert.ok(matchesSearch('NOVÁKOVA ŠÁRKA', ['Šárka Nováková']));
  assert.ok(!matchesSearch('Novotný', ['Šárka Nováková']));
  assert.ok(matchesSearch('', []));
});
