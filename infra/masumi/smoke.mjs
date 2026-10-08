// Operator-authorized, scripted agent checkout on Preprod. No mainnet support.
// Uses the seeded customer session for the test mandate approval; this is not a
// claim that independent GrokBot accounts performed a negotiation or approval.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = resolve(root, 'data/masumi-live-smoke.json');
const access = JSON.parse(readFileSync(resolve(root, 'data/railway-access.json'), 'utf8'));
const base = 'https://pneu007-production.up.railway.app';
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  network: 'Preprod', driver: 'operator-authorized scripted customer/business agent APIs',
  phase: 'preparing', started_at: new Date().toISOString(),
};
const save = () => writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const customer = { authorization: `Bearer ${access.LEGACY_CUSTOMER_AGENT_B_TOKEN}` };
const business = { authorization: `Bearer ${access.LEGACY_BUSINESS_AGENT_TOKEN}` };

async function api(route, headers = {}, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { ...headers, 'content-type': 'application/json', ...(body === undefined ? {} : { origin: base }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try { data = await response.json(); }
  catch { const error = new Error(`HTTP ${response.status} ${route}: invalid JSON response`); error.status = response.status; throw error; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${route}: ${data.error?.code ?? data.error ?? 'request failed'}`);
    error.status = response.status;
    throw error;
  }
  return { data, response };
}

try {
  const config = (await api('/api/payments/config')).data;
  if (config.provider !== 'masumi' || config.network !== 'Preprod' || !config.purchase_ready
    || config.timing_profile !== 'preprod_smoke' || config.checkout_network_fee !== '15000000'
    || !/^[a-f0-9]{56,64}$/.test(config.seller_id ?? '')) {
    throw new Error('The public application is not ready for this controlled Preprod smoke test.');
  }
  const service = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18,
    rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
  if (!state.case_id) {
    const slots = (await api('/api/agent/availability?service_id=tyre_change', business)).data.slots;
    const slot = slots.find(value => value.id !== 'slot-main' && Date.parse(value.start_at) > Date.now());
    if (!slot) throw new Error('No separate future smoke-test appointment is available.');
    state.slot = slot;
    state.case_id = (await api('/api/agent/cases', customer, { service_spec: service })).data.case.id;
    save();
  }
  if (!state.mandate_id) {
    const mandate = { case_id: state.case_id, mode: 'book', service_spec: service,
      max_total_minor: 250000, max_deposit_minor: 50000, payment_mode: 'deposit',
      latest_service_end: state.slot.end_at, expires_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      allow_extras: false, currency: 'CZK', network: 'Preprod', asset: 'lovelace',
      max_asset_quantity: '5000000', max_network_fee: '15000000', mapping_version: 'demo-map-v1',
      seller_id: config.seller_id };
    state.mandate_id = (await api('/api/agent/mandates', customer, mandate)).data.mandate.id;
    state.authorization_limits = mandate;
    save();
  }
  if (!state.mandate_approved) {
    const login = await api('/api/login', {}, { username: 'customer-b', password: access.LEGACY_CUSTOMER_B_PASSWORD });
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie || !login.data.csrf_token) throw new Error('Test customer session unavailable.');
    const approved = (await api(`/api/admin/mandates/${state.mandate_id}/approve`,
      { cookie, 'x-csrf-token': login.data.csrf_token }, {})).data.mandate;
    if (approved.status !== 'approved') throw new Error('Test mandate approval failed.');
    state.mandate_approved = true;
    state.approval_driver = 'operator automation using the seeded customer-b human session';
    save();
  }
  if (!state.quote_id) {
    const quote = (await api(`/api/agent/cases/${state.case_id}/quotes`, business,
      { slot_id: state.slot.id, discount_bps: 0 })).data.quote;
    state.quote_id = quote.id;
    state.quote_version = quote.version;
    save();
  }
  if (!state.order_id) {
    state.order_id = (await api(`/api/agent/cases/${state.case_id}/accept`, customer,
      { quote_id: state.quote_id, mandate_id: state.mandate_id })).data.order.id;
    save();
  }
  if (!state.checkout_dispatched_at) {
    state.checkout_dispatched_at = new Date().toISOString();
    state.phase = 'checkout_dispatched';
    save(); // Persist the order before the request that can fund the escrow.
    const checkout = (await api(`/api/agent/orders/${state.order_id}/checkout`, business, {})).data;
    state.checkout_response = checkout;
    save();
  }
  console.log(JSON.stringify({ order_id: state.order_id, phase: state.phase }));
  let previous = '';
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    let order;
    try {
      order = (await api(`/api/agent/orders/${state.order_id}`, customer)).data;
    } catch (error) {
      if (error.status !== undefined && error.status < 500) throw error;
      state.last_read_warning_at = new Date().toISOString();
      state.read_retry_count = (state.read_retry_count ?? 0) + 1;
      save();
      if (state.read_retry_count === 1) console.log('Read-only status lookup interrupted; reconnecting without another checkout.');
      await new Promise(resolve => setTimeout(resolve, 10000));
      continue;
    }
    delete state.error;
    const payment = order.payment ?? order.intent;
    state.latest = order;
    state.phase = payment?.state ?? 'awaiting_payment_intent';
    state.updated_at = new Date().toISOString();
    if (order.receipt && payment) {
      const expected = createHash('sha256').update(`${payment.identifier_from_purchaser};${JSON.stringify(order.receipt)}`).digest('hex');
      const submitted = payment.observation?.raw?.payment?.resultHash;
      state.expected_output_hash = expected;
      if (submitted) {
        if (submitted !== expected) throw new Error('Persisted receipt does not match the submitted result hash.');
        state.result_hash_verified = true;
      }
    }
    save();
    const summary = JSON.stringify({ order_id: state.order_id, payment_state: state.phase,
      booking_id: order.booking?.id ?? null, result_hash_verified: state.result_hash_verified ?? false,
      transaction_hash: payment?.observation?.transaction_hash ?? null,
      error: order.payment_error?.code ?? null });
    if (summary !== previous) { console.log(summary); previous = summary; }
    if (state.phase === 'seller_paid') {
      if (!order.booking || !order.receipt || !state.result_hash_verified) throw new Error('Settlement evidence is incomplete.');
      state.completed_at = new Date().toISOString();
      save();
      process.exit(0);
    }
    if (['failed', 'refunded'].includes(state.phase)) throw new Error('The controlled purchase did not settle to the seller.');
    if (order.payment_error && !['MASUMI_TRANSPORT_UNCERTAIN', 'MASUMI_SETTLEMENT_UNAVAILABLE', 'PROVIDER_TEMPORARILY_UNAVAILABLE'].includes(order.payment_error.code)) {
      throw new Error('The persisted payment needs reconciliation: ' + order.payment_error.code);
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error('Settlement remains pending; inspect the persisted order before further action.');
} catch (error) {
  state.error = error instanceof Error ? error.message : 'Smoke test unavailable';
  save();
  console.error(state.error);
  process.exitCode = 1;
}
