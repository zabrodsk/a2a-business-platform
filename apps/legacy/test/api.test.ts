import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { PaymentJob, PaymentObservation, PaymentProvider, PaymentRequest, ServiceSpec } from '../../../packages/contracts/index.js';
import { SourceRegistry, type Citation, type RulebookProposal } from '../../../packages/audit/index.js';
import { LocalDemoProvider, paymentProviderStatus } from '../../../packages/payments/index.js';
import { createLegacy, type LegacyOptions } from '../src/server.js';
import { loadLegacyConfig } from '../src/config.js';
import { ALL_SCOPES } from '../src/handoru/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const clock = () => new Date('2026-10-08T08:00:00.000Z');
const password = 'test-human-password-0123456789';
const ownerSetup = 'test-separate-handoru-owner-setup-0123456789';
const tokens = { business: 'test-business-secret-012345678901', a: 'test-customer-a-secret-012345678901', b: 'test-customer-b-secret-012345678901' };
const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
type Client = (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;

async function fixture(t: TestContext, extraEnv: NodeJS.ProcessEnv = {}, options: LegacyOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-api-test-'));
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  cpSync(join(root, 'fixtures/internal'), join(dir, 'fixtures/internal'), { recursive: true });
  mkdirSync(join(dir, 'apps/legacy/public'), { recursive: true });
  for (const file of ['index.html', 'kalkulator.html', 'kontakt.html', 'podminky.html']) writeFileSync(join(dir, 'apps/legacy/public', file), `<h1>Explicit TEST FIXTURE ${file}</h1>`);
  const path = join(dir, 'fixtures/internal/systems.json');
  const systems = JSON.parse(readFileSync(path, 'utf8'));
  if (extraEnv.PAYMENT_PROVIDER !== 'masumi') { systems.facts.provider = 'local_demo'; systems.facts.network = 'local'; }
  writeFileSync(path, JSON.stringify(systems));
  const registry = new SourceRegistry(dir);
  const cfg = loadLegacyConfig({
    NODE_ENV: 'production', LEGACY_PORT: '0', LEGACY_PUBLIC_URL: 'http://localhost:8790',
    LEGACY_DB_PATH: join(dir, 'test.sqlite'), LEGACY_RECONCILIATION_MS: '0',
    LEGACY_OWNER_PASSWORD: password, LEGACY_STAFF_PASSWORD: password,
    HANDORU_OWNER_SETUP_SECRET: ownerSetup,
    LEGACY_CUSTOMER_A_PASSWORD: password, LEGACY_CUSTOMER_B_PASSWORD: password,
    LEGACY_BUSINESS_AGENT_TOKEN: tokens.business, LEGACY_CUSTOMER_AGENT_A_TOKEN: tokens.a,
    LEGACY_CUSTOMER_AGENT_B_TOKEN: tokens.b, LEGACY_RELAY_ADMIN_TOKEN: 'test-relay-secret-012345678901',
    ...extraEnv,
  });
  const system = createLegacy(cfg, { now: clock, registry, ...options });
  const server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await system.close(); rmSync(dir, { recursive: true, force: true });
  });
  const client = (headers: Record<string, string> = {}): Client => (path, body, extraHeaders = {}) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const publicCall = client();
  async function login(username: string) {
    const response = await publicCall('/api/login', { username, password });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(response.headers.get('set-cookie') ?? '', /SameSite=Strict/i);
    const data = await response.json();
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { call: client({ cookie, 'x-csrf-token': data.csrf_token }), cookie, csrf: data.csrf_token, actor: data.actor };
  }
  return { ...system, cfg, registry, publicCall, client, login, base, server,
    business: client({ authorization: `Bearer ${tokens.business}` }),
    agentA: client({ authorization: `Bearer ${tokens.a}` }),
    agentB: client({ authorization: `Bearer ${tokens.b}` }),
  };
}
async function createHumanOrder(call: Client, contact: { name: string; email: string; phone: string } | undefined = undefined) {
  const response = await call('/api/orders', { service_spec: service, slot_id: 'slot-main', ...contact });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).order as { id: string; status: string; customer_id: string };
}
async function humanPurchase(f: Awaited<ReturnType<typeof fixture>>, mode: 'deposit' | 'full' = 'deposit', contact: { name: string; email: string; phone: string } | undefined = undefined) {
  const session = await f.login('customer-a');
  const order = await createHumanOrder(session.call, contact);
  const response = await session.call(`/api/orders/${order.id}/checkout`, { confirm: true, payment_mode: mode, max_network_fee: '2000000' });
  assert.equal(response.status, 200, await response.clone().text());
  return { ...session, order, purchase: await response.json() };
}
// Explicit test-authored audit proposal. Runtime never seeds an active rulebook.
function proposal(registry: SourceRegistry): RulebookProposal {
  const cite = (id: string): Citation => { const source = registry.get(id); return { source_id: id, version: source.version, hash: source.hash, excerpt: source.content }; };
  const params = registry.config();
  const operationKeys = ['auto_discount_bps', 'owner_approval_limit_bps', 'hard_discount_limit_bps', 'offer_ttl_seconds', 'deposit_minor'];
  const evidence = Object.fromEntries(Object.keys(params).map(key => [key, [cite(key === 'supplier_allowed_actions' ? 'internal-partners' : operationKeys.includes(key) ? 'internal-operations' : 'internal-systems')]])) as RulebookProposal['evidence'];
  return { params, evidence, profile: { name: 'Pneu 007 TEST FIXTURE', summary: 'Synthetic test-authored audit proposal.', systems: ['legacy-orders'], partners: ['Pneu Partner Demo'], channels: ['web'], citations: [cite('internal-systems')] }, findings: [] };
}
async function activate(f: Awaited<ReturnType<typeof fixture>>) {
  const proposed = await f.business('/api/agent/rulebook/proposals', proposal(f.registry));
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const rulebook = (await proposed.json()).rulebook;
  const version = rulebook.version as number;
  const legacyOwner = await f.login('owner');
  const signup = await f.publicCall('/api/handoru/v1/owner/signup', {
    email: 'handoru-owner@example.test', password, setup_secret: ownerSetup,
  });
  assert.equal(signup.status, 201, await signup.clone().text());
  const human = await signup.json();
  const cookie = `${legacyOwner.cookie}; ${signup.headers.get('set-cookie')!.split(';')[0]!}`;
  // Adopt the pre-upgrade compatibility installation in this trusted test fixture.
  // The separate onboarding integration suite verifies website proof and human binding.
  f.store.db.prepare('INSERT INTO handoru_memberships(owner_id,business_id) VALUES(?,?)').run(human.owner.id, 'pneu007');
  const owner = { ...legacyOwner, cookie, handoruOwner: human.owner as { id: string; email: string }, call: ((path, body, headers = {}) => {
    const handoruOperation = path.startsWith('/api/handoru/v1/') || /^\/api\/admin\/(rulebooks\/[^/]+\/activate|approvals\/[^/]+\/decide)$/.test(path);
    return f.client({ cookie, 'x-csrf-token': handoruOperation ? human.csrf_token : legacyOwner.csrf })(path, body, headers);
  }) as Client };
  const response = await owner.call(`/api/admin/rulebooks/${version}/activate`, { payload_hash: rulebook.payload_hash });
  assert.equal(response.status, 200, await response.clone().text());
  const hash = (await response.json()).rulebook.payload_hash as string;
  const base = '/api/handoru/v1/businesses/pneu007';
  const provisioned = await f.business(`${base}/relay`, {}, { 'idempotency-key': 'test-compatibility-relay' });
  assert.equal(provisioned.status, 201, await provisioned.clone().text());
  const probe = await f.business(`${base}/relay/probe`, {});
  assert.equal(probe.status, 201, await probe.clone().text());
  const inbox = await f.business(`${base}/relay/probe/inbox`);
  assert.equal(inbox.status, 200, await inbox.clone().text());
  const nonce = (await inbox.json()).items[0].nonce as string;
  const answered = await f.business(`${base}/relay/probe/answer`, {
    nonce, rulebook_hash: hash, method: 'polling', evidence: 'Scripted API test; does not prove a specific GrokBot runtime.',
  });
  assert.equal(answered.status, 200, await answered.clone().text());
  const authorized = await owner.call(`${base}/owner/connections/compatibility-pneu007/authorize-operation`, {
    expected_epoch: f.handoru.business('pneu007').execution_epoch, scopes: ALL_SCOPES,
  });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  return owner;
}

test('fresh business has no active rulebook and refuses autonomous availability', async t => {
  const f = await fixture(t), owner = await f.login('owner');
  const state = await (await owner.call('/api/admin/rulebooks')).json();
  assert.deepEqual(state.rulebooks, []); assert.equal(state.active, null);
  const response = await f.business('/api/agent/availability');
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'FORBIDDEN');
});

test('public calculator returns the authoritative price', async t => {
  const f = await fixture(t);
  const price = await f.publicCall('/api/pricing/calculate', { service_spec: service });
  assert.equal(price.status, 200); assert.equal((await price.json()).total_minor, 247200);
});

test('inquiry without an optional name creates no booking or payment', async t => {
  const f = await fixture(t);
  const before = f.store.calendar().length;
  const inquiry = await f.publicCall('/api/inquiries', { email: 'demo@example.test', phone: '+420777000007', service_spec: service });
  assert.equal(inquiry.status, 201, await inquiry.clone().text());
  const result = await inquiry.json();
  assert.equal(result.booking_created, false); assert.equal(result.payment_created, false);
  assert.equal(f.store.calendar().length, before); assert.deepEqual(f.store.listPaymentIntents(), []);
});

for (const mode of ['deposit', 'full'] as const) test(`human ${mode} purchase confirms the booking before any rulebook exists`, async t => {
  const f = await fixture(t), { purchase } = await humanPurchase(f, mode);
  assert.equal(purchase.order.status, 'confirmed', JSON.stringify(purchase.payment_error));
  assert.equal(purchase.booking.status, 'confirmed'); assert.equal(purchase.simulation, true);
  assert.equal(purchase.intent.provider, 'local_demo'); assert.equal(purchase.intent.network, 'local');
  assert.equal(purchase.intent.amount_minor, mode === 'deposit' ? 50000 : 247200);
  assert.equal(purchase.order.balance_minor, mode === 'deposit' ? 197200 : 0);
  assert.equal(purchase.receipt.order_id, purchase.order.id);
  assert.equal(purchase.intent.authorization.kind, 'human_checkout');
  assert.equal(purchase.intent.authorization.actor_id, 'human-customer-a');
  assert.deepEqual(f.rulebooks.list(), []);
});

test('browser mutation requires CSRF and forbids a foreign origin', async t => {
  const f = await fixture(t), session = await f.login('customer-a');
  const noCsrf = await f.client({ cookie: session.cookie })('/api/orders', { service_spec: service, slot_id: 'slot-main' });
  assert.equal(noCsrf.status, 403);
  const wrongOrigin = await session.call('/api/orders', { service_spec: service, slot_id: 'slot-main' }, { origin: 'https://foreign.example' });
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(f.store.listPaymentIntents(), []);
});

test('checkout requires explicit customer confirmation and never creates a hold without it', async t => {
  const f = await fixture(t), session = await f.login('customer-a'), order = await createHumanOrder(session.call);
  const response = await session.call(`/api/orders/${order.id}/checkout`, { payment_mode: 'deposit', max_network_fee: '2000000' });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'HUMAN_CONFIRMATION_REQUIRED');
  assert.deepEqual(f.store.listPaymentIntents(), []);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM booking_holds').get() as { n: number }).n, 0);
});

test('customer B cannot read or purchase customer A order', async t => {
  const f = await fixture(t), a = await f.login('customer-a'), b = await f.login('customer-b');
  const order = await createHumanOrder(a.call);
  assert.equal((await b.call(`/api/orders/${order.id}`)).status, 403);
  assert.equal((await b.call(`/api/orders/${order.id}/checkout`, { confirm: true, payment_mode: 'deposit', max_network_fee: '2000000' })).status, 403);
  assert.deepEqual(f.store.listPaymentIntents(), []);
});

test('agent credentials cannot impersonate human checkout, mandate approval or owner activation', async t => {
  const f = await fixture(t), customer = await f.login('customer-a');
  const order = await createHumanOrder(customer.call);
  assert.equal((await f.agentA(`/api/orders/${order.id}/checkout`, { confirm: true, mode: 'human', payment_mode: 'deposit', max_network_fee: '2000000' })).status, 403);
  assert.equal((await f.agentA('/api/admin/mandates/unknown/approve', { mode: 'human' })).status, 403);
  assert.equal((await f.business('/api/admin/rulebooks/1/activate', {})).status, 403);
  assert.deepEqual(f.store.listPaymentIntents(), []);
});

test('staff cannot activate a rulebook or decide owner approvals', async t => {
  const f = await fixture(t), staff = await f.login('staff');
  for (const path of ['/api/admin/rulebooks/1/activate', '/api/admin/approvals/unknown/decide']) {
    const response = await staff.call(path, { decision: 'approved' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'HUMAN_REQUIRED');
  }
});

test('legacy owner admin credentials cannot activate rules or decide Handle owner exceptions', async t => {
  const f = await fixture(t), legacyOwner = await f.login('owner');
  for (const path of ['/api/admin/rulebooks/1/activate', '/api/admin/approvals/unknown/decide']) {
    const response = await legacyOwner.call(path, { decision: 'approved' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'HUMAN_REQUIRED');
  }
  assert.equal((f.handoru.db.prepare('SELECT count(*) AS n FROM handoru_owners').get() as { n: number }).n, 0);
  assert.deepEqual(f.rulebooks.list(), []);
});

test('unsupported structured inputs fail as client errors without server exceptions', async t => {
  const f = await fixture(t), session = await f.login('customer-a');
  const responses = [
    await f.publicCall('/api/pricing/calculate', { service_spec: { ...service, service_id: 'unknown' } }),
    await session.call('/api/orders', { service_spec: service, slot_id: 'slot-main', customer_id: 'customer-002' }),
    await f.agentA('/api/agent/cases', { service_spec: service, unexpected: true }),
    await f.agentA('/api/agent/mandates', []),
  ];
  for (const response of responses) { assert.ok(response.status >= 400 && response.status < 500, await response.clone().text()); assert.ok((await response.json()).error.code); }
});

test('Masumi selected without configuration stays unavailable and creates no simulated payment or hold', async t => {
  const f = await fixture(t, { PAYMENT_PROVIDER: 'masumi' });
  const status = await (await f.publicCall('/api/payments/config')).json();
  assert.equal(status.provider, 'masumi'); assert.equal(status.simulation, false);
  assert.equal(status.configured, false); assert.equal(status.live_verification, 'NOT_RUN');
  const session = await f.login('customer-a'), order = await createHumanOrder(session.call);
  const response = await session.call(`/api/orders/${order.id}/checkout`, { confirm: true, payment_mode: 'deposit', max_network_fee: '2000000' });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'PAYMENT_NOT_READY');
  assert.deepEqual(f.store.listPaymentIntents(), []);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM booking_holds').get() as { n: number }).n, 0);
});

test('funded booking is exported as a valid UTC iCalendar event', async t => {
  const f = await fixture(t), { call, order, purchase } = await humanPurchase(f);
  assert.equal(purchase.booking?.status, 'confirmed');
  const response = await call(`/api/orders/${order.id}/confirmation.ics`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/calendar/);
  const ics = await response.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2.0/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z\r\n/);
  assert.match(ics, /DTEND:\d{8}T\d{6}Z\r\n/);
  assert.match(ics, /STATUS:CONFIRMED\r\n/); assert.match(ics, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
});

test('audit reads pseudonymized evidence while file paths and credentials stay inaccessible', async t => {
  const f = await fixture(t);
  const exportResponse = await f.business('/api/audit/export/orders');
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.text();
  assert.ok(!exported.includes(password)); assert.ok(!exported.includes(tokens.business));
  assert.equal((await f.agentA('/api/audit/sources')).status, 403);
  for (const path of ['/data/legacy-access.json', '/data/legacy.db', '/.env.legacy.local', '/fixtures/internal/systems.json', '/api/audit/export/..%2F..%2F.env']) {
    const response = await f.business(path);
    assert.ok(response.status >= 400 && response.status < 500, `${path}: ${response.status}`);
    const content = await response.text(); assert.ok(!content.includes(password)); assert.ok(!content.includes(tokens.business));
  }
});

test('agent purchase requires human mandate and owner discount approval and executes real checkout mapping', async t => {
  const f = await fixture(t, {}, { paymentProvider: new LocalDemoProvider({ now: clock }) });
  const owner = await activate(f), human = await f.login('customer-a');
  const opened = await f.agentA('/api/agent/cases', { service_spec: service });
  assert.equal(opened.status, 201); const caseId = (await opened.json()).case.id as string;
  assert.equal((await f.agentB(`/api/agent/cases/${caseId}`)).status, 403);
  const proposed = await f.agentA('/api/agent/mandates', {
    case_id: caseId, mode: 'book', service_spec: service, max_total_minor: 250000, max_deposit_minor: 50000,
    payment_mode: 'deposit', latest_service_end: '2026-10-17T22:00:00Z', expires_at: '2026-10-08T10:00:00Z',
    allow_extras: false, currency: 'CZK', network: 'local', asset: 'lovelace', max_asset_quantity: '25000000',
    max_network_fee: '2000000', mapping_version: 'demo-map-v1', seller_id: 'pneu007-demo',
  });
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const mandateId = (await proposed.json()).mandate.id as string;
  assert.equal((await f.agentA(`/api/admin/mandates/${mandateId}/approve`, {})).status, 403);
  assert.equal((await human.call(`/api/admin/mandates/${mandateId}/approve`, {})).status, 200);
  const quoted = await f.business(`/api/agent/cases/${caseId}/quotes`, { slot_id: 'slot-main', discount_bps: 1000 });
  assert.equal(quoted.status, 201, await quoted.clone().text());
  const { quote, approval } = await quoted.json();
  assert.equal(quote.price.total_minor, 222480); assert.equal(approval.status, 'pending');
  const input = { quote_id: quote.id, mandate_id: mandateId };
  const rejected = await f.agentA(`/api/agent/cases/${caseId}/accept`, input);
  assert.equal(rejected.status, 403); assert.equal((await rejected.json()).error.code, 'OWNER_APPROVAL_REQUIRED');
  const ownerDecision = await owner.call(`/api/admin/approvals/${approval.id}/decide`, { decision: 'approved' });
  assert.equal(ownerDecision.status, 200, await ownerDecision.clone().text());
  assert.equal((await ownerDecision.json()).approval.decided_by, owner.handoruOwner.id);
  assert.equal(f.store.getQuote(quote.id).approved_by, owner.handoruOwner.id);
  const accepted = await f.agentA(`/api/agent/cases/${caseId}/accept`, input);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const orderId = (await accepted.json()).order.id as string;
  const checkout = await f.business(`/api/agent/orders/${orderId}/checkout`, {});
  // Regression: passing extra mapping keys used to cause INVALID_INPUT at this HTTP boundary.
  assert.equal(checkout.status, 200, await checkout.clone().text());
  const purchase = await checkout.json();
  assert.equal(purchase.order.status, 'confirmed', JSON.stringify(purchase.payment_error));
  assert.equal(purchase.intent.authorization.kind, 'agent_mandate');
  assert.equal(purchase.intent.authorization.mandate_id, mandateId);
  assert.equal(purchase.intent.authorization.actor_id, 'customer-agent-a');
  assert.equal(purchase.intent.amount_minor, 50000); assert.equal(purchase.booking.status, 'confirmed');
  assert.equal((await f.agentB(`/api/agent/orders/${orderId}`)).status, 403);
});


test('configured Masumi without a proven isolated fee ceiling refuses purchase before reserving the slot', async t => {
  const f = await fixture(t, {
    PAYMENT_PROVIDER: 'masumi', MASUMI_PAYMENT_SERVICE_URL: 'https://payment.example.test/api/v1',
    MASUMI_PAYMENT_API_KEY: 'test-seller-secret', MASUMI_BUYER_API_KEY: 'test-buyer-secret',
    MASUMI_SELLER_VKEY: 'a'.repeat(64), MASUMI_SKUS: JSON.stringify({ 'deposit-500': 'b'.repeat(64) }),
  });
  const response = await f.publicCall('/api/payments/config'), encoded = await response.text();
  const status = JSON.parse(encoded);
  assert.equal(status.configured, true); assert.equal(status.purchase_ready, false);
  assert.equal(status.simulation, false); assert.equal(status.live_verification, 'NOT_RUN');
  assert.equal(status.seller_id, 'a'.repeat(64)); assert.equal(status.asset, 'lovelace');
  assert.ok(!encoded.includes('test-seller-secret')); assert.ok(!encoded.includes('test-buyer-secret'));
  const session = await f.login('customer-a'), order = await createHumanOrder(session.call);
  const purchase = await session.call(`/api/orders/${order.id}/checkout`, { confirm: true, payment_mode: 'deposit', max_network_fee: '2000000' });
  assert.equal(purchase.status, 503); assert.equal((await purchase.json()).error.code, 'PAYMENT_NOT_READY');
  assert.deepEqual(f.store.listPaymentIntents(), []);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM booking_holds').get() as { n: number }).n, 0);
});

test('full purchase without an approved fixed payment SKU is rejected before a hold is created', async t => {
  const f = await fixture(t), session = await f.login('customer-a');
  const created = await session.call('/api/orders', { service_spec: { ...service, service_id: 'wheel_swap' }, slot_id: 'slot-main' });
  assert.equal(created.status, 201); const order = (await created.json()).order;
  const purchase = await session.call(`/api/orders/${order.id}/checkout`, { confirm: true, payment_mode: 'full', max_network_fee: '2000000' });
  assert.equal(purchase.status, 400); assert.equal((await purchase.json()).error.code, 'PAYMENT_UNSUPPORTED_SKU');
  assert.deepEqual(f.store.listPaymentIntents(), []);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM booking_holds').get() as { n: number }).n, 0);
});


test('login throttle cannot be bypassed by rotating usernames from one client', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await f.publicCall('/api/login', { username: `unknown-rotating-${attempt}`, password });
    assert.equal(response.status, 401);
  }
  const blocked = await f.publicCall('/api/login', { username: 'yet-another-username', password });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'LOGIN_RATE_LIMIT');
  const validButThrottled = await f.publicCall('/api/login', { username: 'owner', password });
  assert.equal(validButThrottled.status, 429);
});

test('explicit owner refund endpoint returns a pending request until observed confirmation', async t => {
  const f = await fixture(t), { call, order, purchase } = await humanPurchase(f);
  const owner = await f.login('owner'), staff = await f.login('staff');
  assert.equal((await call(`/api/admin/orders/${order.id}/refund-request`, {})).status, 403);
  assert.equal((await staff.call(`/api/admin/orders/${order.id}/refund-request`, {})).status, 403);
  const requested = await owner.call(`/api/admin/orders/${order.id}/refund-request`, {});
  assert.equal(requested.status, 200, await requested.clone().text());
  const pending = await requested.json();
  assert.equal(pending.order.status, 'refund_pending'); assert.equal(pending.intent.state, 'refund_requested');
  const confirmed = await call(`/api/orders/${order.id}/payment`);
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.order.status, 'refunded'); assert.equal(result.intent.state, 'refunded');
  assert.equal(result.booking.status, 'cancelled');
  assert.equal((await call(`/api/orders/${order.id}/confirmation.ics`)).status, 409);
  assert.equal(f.store.getPaymentIntent(purchase.intent.intent_id).state, 'refunded');
});

test('owner refund endpoint reports manual compensation for already settled purchases', async t => {
  const f = await fixture(t), { call, order } = await humanPurchase(f);
  const settled = await (await call(`/api/orders/${order.id}/payment`)).json();
  assert.equal(settled.intent.state, 'seller_paid');
  const owner = await f.login('owner');
  const response = await owner.call(`/api/admin/orders/${order.id}/refund-request`, {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'MANUAL_COMPENSATION_REQUIRED');
  assert.equal(f.store.getOrder(order.id).status, 'refund_pending');
});

test('reset is owner-only and unresolved funding preserves the existing rulebook and business state', async t => {
  const f = await fixture(t), owner = await activate(f), staff = await f.login('staff');
  const { purchase } = await humanPurchase(f);
  const rulesBefore = f.rulebooks.list(), ordersBefore = f.store.listOrders();
  assert.equal((await staff.call('/api/admin/reset', {})).status, 403);
  const reset = await owner.call('/api/admin/reset', {});
  assert.equal(reset.status, 409); assert.equal((await reset.json()).error.code, 'UNSAFE_RESET');
  assert.deepEqual(f.rulebooks.list(), rulesBefore);
  assert.deepEqual(f.store.listOrders(), ordersBefore);
  assert.equal(f.store.getPaymentIntent(purchase.intent.intent_id).state, 'result_submitted');
});

test('owner reset after local settlement clears audit and checkout extensions and restores the seed', async t => {
  const f = await fixture(t), baselineOrders = f.store.listOrders().length;
  const owner = await activate(f), { call, order } = await humanPurchase(f, 'deposit', { name: 'Reset contact fixture', email: 'reset@example.test', phone: '+420777000123' });
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM order_contact_snapshots').get() as { n: number }).n, 1);
  await call(`/api/orders/${order.id}/payment`);
  assert.equal(f.store.listPaymentIntents()[0]!.state, 'seller_paid');
  const registration = await (await f.publicCall('/agent/identity', {type:'service_auth',login_hint:'jana.vesela@example.com'})).json();
  const claimAttempt = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token');
  assert.equal((await call('/api/agent/identity/confirm', {claim_attempt_token:claimAttempt,user_code:registration.claim.user_code})).status, 200);
  const credentials = await (await fetch(`${f.base}/oauth2/token`, {method:'POST',body:new URLSearchParams({
    grant_type:'urn:workos:agent-auth:grant-type:claim',claim_token:registration.claim_token,
  })})).json();
  assert.ok(f.agentAuth.identify(credentials.access_token));
  const reset = await owner.call('/api/admin/reset', {});
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal((await reset.json()).ok, true);
  assert.equal(f.store.listOrders().length, baselineOrders);
  assert.deepEqual(f.store.listPaymentIntents(), []); assert.deepEqual(f.rulebooks.list(), []);
  for (const table of ['agent_auth_registrations', 'agent_auth_claim_attempts', 'agent_auth_access_tokens', 'agent_cases', 'agent_mandates', 'agent_approvals', 'human_checkout_authorizations', 'order_contact_snapshots', 'legacy_receipts', 'payment_workflow_errors', 'audit_source_snapshots']) {
    assert.equal((f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  assert.equal(f.agentAuth.identify(credentials.access_token), undefined, 'Reset must invalidate prior agent credentials');
  const state = await (await owner.call('/api/admin/rulebooks')).json();
  assert.equal(state.active, null);
});


test('submitted order contact survives reads and customer profile changes as an immutable snapshot', async t => {
  const f = await fixture(t), customer = await f.login('customer-a'), staff = await f.login('staff');
  const contact = { name: 'Fiktivní objednavatel', email: 'order.contact@example.test', phone: '+420777000123' };
  const created = await customer.call('/api/orders', { service_spec: service, slot_id: 'slot-main', ...contact });
  assert.equal(created.status, 201, await created.clone().text());
  const result = await created.json();
  assert.deepEqual(result.contact, contact);
  f.store.db.prepare('UPDATE customers SET name=?,email=?,phone=? WHERE id=?').run('Changed profile', 'changed@example.test', '+420777999999', 'customer-001');
  const own = await customer.call(`/api/orders/${result.order.id}`);
  assert.equal(own.status, 200); assert.deepEqual((await own.json()).contact, contact);
  const admin = await staff.call('/api/admin/orders');
  assert.equal(admin.status, 200);
  const adminOrders = (await admin.json()).orders;
  assert.deepEqual(adminOrders.find((entry: { id: string }) => entry.id === result.order.id).contact, contact);
});

for (const [label, invalid] of [
  ['email', { email: 'not-an-email', phone: '+420777000123' }],
  ['empty phone', { email: 'valid@example.test', phone: '' }],
  ['non-string phone', { email: 'valid@example.test', phone: 123 }],
] as const) test(`invalid contact ${label} is rejected without creating an order`, async t => {
  const f = await fixture(t), customer = await f.login('customer-a');
  const before = f.store.listOrders().length;
  const response = await customer.call('/api/orders', { service_spec: service, slot_id: 'slot-main', name: 'Test contact', ...invalid });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_CONTACT');
  assert.equal(f.store.listOrders().length, before);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM order_contact_snapshots').get() as { n: number }).n, 0);
});

test('order without submitted contact reads the existing customer contact', async t => {
  const f = await fixture(t), customer = await f.login('customer-a');
  const expected = f.store.db.prepare('SELECT name,email,phone FROM customers WHERE id=?').get('customer-001');
  const order = await createHumanOrder(customer.call);
  const response = await customer.call(`/api/orders/${order.id}`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).contact, expected);
});


/** Partial-dispatch fixture: remote escrow already exists, resume funds the same ID. */
class OwnerActionProvider extends LocalDemoProvider {
  starts = 0;
  resumes: Array<{ nonce: string; input: string; providerId: string }> = [];
  authorizations: string[] = [];
  async start(request: PaymentRequest) {
    this.starts++;
    return { ...await super.start(request), state: 'purchase_requested' as const };
  }
  async resumePurchase(request: PaymentRequest, previous?: PaymentObservation) {
    assert.ok(previous?.provider_payment_id, 'resume must retain the original remote escrow');
    this.resumes.push({ nonce: request.identifier_from_purchaser, input: request.input_hash, providerId: previous.provider_payment_id });
    return super.start(request);
  }
  async authorizeRefund(request: PaymentRequest, previous: PaymentObservation) {
    assert.equal(previous.state, 'refund_requested');
    assert.ok(previous.provider_payment_id);
    this.authorizations.push(previous.provider_payment_id);
    return super.observe(request, previous);
  }
}

test('owner resumes the original uncertain purchase and authorizes its requested refund without a new charge', async t => {
  const provider = new OwnerActionProvider({ now: clock });
  const f = await fixture(t, {}, { paymentProvider: provider });
  const { order, purchase } = await humanPurchase(f), owner = await f.login('owner');
  assert.equal(purchase.intent.state, 'purchase_requested');
  assert.equal(purchase.order.status, 'awaiting_payment');
  const response = await owner.call(`/api/admin/orders/${order.id}/resume-payment`, { confirm: true });
  assert.equal(response.status, 200, await response.clone().text());
  const resumed = await response.json();
  assert.equal(resumed.intent.intent_id, purchase.intent.intent_id);
  assert.equal(resumed.intent.observation.provider_payment_id, purchase.intent.observation.provider_payment_id);
  assert.equal(resumed.order.status, 'confirmed');
  assert.deepEqual(provider.resumes, [{ nonce: purchase.intent.identifier_from_purchaser, input: purchase.intent.input_hash, providerId: purchase.intent.observation.provider_payment_id }]);
  assert.equal(provider.starts, 1);
  const duplicate = await owner.call(`/api/admin/orders/${order.id}/resume-payment`, { confirm: true });
  assert.equal(duplicate.status, 409); assert.equal(provider.resumes.length, 1);
  const refund = await owner.call(`/api/admin/orders/${order.id}/refund-request`, {});
  assert.equal(refund.status, 200); assert.equal((await refund.json()).intent.state, 'refund_requested');
  const authorized = await owner.call(`/api/admin/orders/${order.id}/authorize-refund`, { confirm: true });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  const completed = await authorized.json();
  assert.equal(completed.intent.state, 'refunded'); assert.equal(completed.order.status, 'refunded');
  assert.deepEqual(provider.authorizations, [purchase.intent.observation.provider_payment_id]);
  assert.equal(f.store.listPaymentIntents().length, 1);
});

test('business agent, staff and customer cannot invoke owner payment recovery operations', async t => {
  const provider = new OwnerActionProvider({ now: clock });
  const f = await fixture(t, {}, { paymentProvider: provider });
  const { call, order } = await humanPurchase(f), staff = await f.login('staff');
  for (const invoke of [f.business, staff.call, call]) for (const action of ['resume-payment', 'authorize-refund']) {
    const response = await invoke(`/api/admin/orders/${order.id}/${action}`, { confirm: true });
    assert.equal(response.status, 403);
  }
  assert.equal(provider.resumes.length, 0); assert.equal(provider.authorizations.length, 0); assert.equal(provider.starts, 1);
});

test('owner recovery operations require explicit confirmation before invoking the provider', async t => {
  const provider = new OwnerActionProvider({ now: clock });
  const f = await fixture(t, {}, { paymentProvider: provider });
  const { order } = await humanPurchase(f), owner = await f.login('owner');
  for (const action of ['resume-payment', 'authorize-refund']) {
    const response = await owner.call(`/api/admin/orders/${order.id}/${action}`, { confirm: false });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'HUMAN_CONFIRMATION_REQUIRED');
  }
  assert.equal(provider.resumes.length, 0); assert.equal(provider.authorizations.length, 0);
});

test('local provider recovery methods fail explicitly when unsupported', async t => {
  const f = await fixture(t), { order } = await humanPurchase(f), owner = await f.login('owner');
  const resume = await owner.call(`/api/admin/orders/${order.id}/resume-payment`, { confirm: true });
  assert.equal(resume.status, 409); assert.equal((await resume.json()).error.code, 'RESUME_UNSUPPORTED');
  const refund = await owner.call(`/api/admin/orders/${order.id}/refund-request`, {});
  assert.equal(refund.status, 200);
  const authorize = await owner.call(`/api/admin/orders/${order.id}/authorize-refund`, { confirm: true });
  assert.equal(authorize.status, 409); assert.equal((await authorize.json()).error.code, 'REFUND_AUTHORIZATION_UNAVAILABLE');
});


/** Fake external proof for protocol tests only. This does not verify a live Masumi node or chain. */
class MipSellerFixture implements PaymentProvider {
  readonly name = 'masumi' as const;
  starts = 0;
  prepared: PaymentRequest[] = [];
  submitted: string[] = [];
  preparationGate?: Promise<void>;
  funded = false;
  async start(_request: PaymentRequest): Promise<PaymentObservation> { this.starts++; throw new Error('MIP seller route must never dispatch a buyer charge'); }
  async prepareJob(request: PaymentRequest): Promise<PaymentJob> {
    this.prepared.push(structuredClone(request));
    await this.preparationGate;
    return { id: request.intent_id, blockchainIdentifier: 'c'.repeat(64), payByTime: 1791448200000,
      submitResultTime: 1791448800000, unlockTime: 1791449400000, externalDisputeUnlockTime: 1791450000000,
      agentIdentifier: 'd'.repeat(64), sellerVKey: request.seller_id,
      identifierFromPurchaser: request.identifier_from_purchaser, input_hash: request.input_hash };
  }
  async observe(request: PaymentRequest): Promise<PaymentObservation> {
    return { provider: 'masumi', network: 'Preprod', state: this.funded ? 'escrow_funded' : 'purchase_requested',
      provider_payment_id: 'mip-test-original-payment', seller_payment_id: 'mip-test-original-seller-request',
      ...(this.funded ? { transaction_hash: 'e'.repeat(64) } : {}),
      asset: request.asset, asset_quantity: request.asset_quantity, seller_id: request.seller_id,
      input_hash: request.input_hash, observed_at: clock().toISOString(), raw: { syntheticProtocolFixture: true } };
  }
  async submitResult(_request: PaymentRequest, previous: PaymentObservation, hash: string) {
    this.submitted.push(hash);
    return { ...previous, state: 'result_submitted' as const, raw: { syntheticProtocolFixture: true, result_hash: hash } };
  }
  async requestRefund(_request: PaymentRequest, previous: PaymentObservation) { return { ...previous, state: 'refund_requested' as const }; }
}
async function mipFixture(t: TestContext, purchaseReady = true) {
  const provider = new MipSellerFixture();
  const f = await fixture(t, { PAYMENT_PROVIDER: 'masumi', MASUMI_SELLER_VKEY: 'a'.repeat(64) }, {
    paymentProvider: provider,
    paymentStatus: () => {
      const status = paymentProviderStatus({ PAYMENT_PROVIDER: 'masumi' });
      if (status.purchase_ready === undefined) throw new Error('Expected explicit Masumi readiness contract');
      return { ...status, configured: true, purchase_ready: purchaseReady };
    },
  });
  await activate(f);
  const human = await f.login('customer-a');
  const opened = await f.agentA('/api/agent/cases', { service_spec: service });
  assert.equal(opened.status, 201); const caseId = (await opened.json()).case.id;
  const proposed = await f.agentA('/api/agent/mandates', {
    case_id: caseId, mode: 'book', service_spec: service, max_total_minor: 250000, max_deposit_minor: 50000,
    payment_mode: 'deposit', latest_service_end: '2026-10-17T22:00:00Z', expires_at: '2026-10-08T10:00:00Z',
    allow_extras: false, currency: 'CZK', network: 'Preprod', asset: 'lovelace', max_asset_quantity: '25000000',
    max_network_fee: '2500000', mapping_version: 'demo-map-v1', seller_id: 'a'.repeat(64),
  });
  assert.equal(proposed.status, 201, await proposed.clone().text()); const mandateId = (await proposed.json()).mandate.id;
  assert.equal((await human.call(`/api/admin/mandates/${mandateId}/approve`, {})).status, 200);
  const quoted = await f.business(`/api/agent/cases/${caseId}/quotes`, { slot_id: 'slot-main', discount_bps: 0 });
  assert.equal(quoted.status, 201, await quoted.clone().text()); const quote = (await quoted.json()).quote;
  const accepted = await f.agentA(`/api/agent/cases/${caseId}/accept`, { quote_id: quote.id, mandate_id: mandateId });
  assert.equal(accepted.status, 200, await accepted.clone().text()); const orderId = (await accepted.json()).order.id as string;
  return { ...f, provider, orderId, startInput: { input_data: { order_id: orderId }, identifier_from_purchaser: '0123456789abcdef0123' } };
}

test('MIP003 seller job prepares once without dispatching buyer funding and reports completion only after verified funds', async t => {
  const f = await mipFixture(t);
  const profile = await (await f.publicCall('/api/agent/profile')).json();
  assert.equal(profile.payment_api.base_url, 'http://localhost:8790/masumi');
  assert.equal(profile.payment_api.standard, 'MIP-003');
  const availability = await (await f.publicCall('/masumi/availability')).json();
  assert.equal(availability.status, 'available'); assert.equal(availability.simulation, false);
  const schema = await (await f.publicCall('/masumi/input_schema')).json();
  assert.equal(schema.input_data[0].id, 'order_id');
  const response = await f.agentA('/masumi/start_job', f.startInput);
  assert.equal(response.status, 200, await response.clone().text()); const job = await response.json();
  assert.equal(f.provider.starts, 0); assert.equal(f.provider.prepared.length, 1);
  const intent = f.store.getPaymentIntent(job.id);
  assert.equal(intent.identifier_from_purchaser, f.startInput.identifier_from_purchaser);
  assert.equal(intent.input_hash, createHash('sha256').update(`${f.startInput.identifier_from_purchaser};${JSON.stringify(f.startInput.input_data)}`).digest('hex'));
  assert.equal(f.store.getOrder(f.orderId).status, 'awaiting_payment');
  assert.equal(f.store.calendar().filter(value => value.order_id === f.orderId).length, 0);
  const repeated = await f.agentA('/masumi/start_job', f.startInput);
  assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), job); assert.equal(f.provider.prepared.length, 1);
  const waiting = await f.agentA(`/masumi/status?job_id=${job.id}`);
  assert.equal(waiting.status, 200); const pending = await waiting.json();
  assert.equal(pending.status, 'awaiting_payment'); assert.equal(pending.result, undefined);
  assert.equal(f.store.getOrder(f.orderId).status, 'awaiting_payment');
  f.provider.funded = true;
  const completed = await f.agentA(`/masumi/status?job_id=${job.id}`);
  assert.equal(completed.status, 200); const done = await completed.json();
  assert.equal(done.status, 'completed');
  assert.equal(done.input_hash, intent.input_hash);
  assert.equal(done.output_hash, createHash('sha256').update(`${f.startInput.identifier_from_purchaser};${done.result}`).digest('hex'));
  assert.equal(f.provider.submitted.at(-1), done.output_hash);
  const receipt = JSON.parse(done.result);
  assert.equal(receipt.order_id, f.orderId); assert.equal(receipt.fulfilment, 'confirmed_fictional_reservation');
  assert.equal(f.store.getOrder(f.orderId).status, 'confirmed');
  assert.equal(f.provider.starts, 0);
});

test('MIP003 discovery remains unavailable when buyer purchasing configuration prevents job creation', async t => {
  const f = await mipFixture(t, false);
  const availability = await (await f.publicCall('/masumi/availability')).json();
  assert.equal(availability.status, 'unavailable');
  const response = await f.agentA('/masumi/start_job', f.startInput);
  assert.equal(response.status, 503);
  assert.equal(f.provider.prepared.length, 0);
  assert.equal(f.store.listPaymentIntents().length, 0);
});

test('MIP003 rejects a changed purchaser nonce or unknown job input without preparing a second seller request', async t => {
  const f = await mipFixture(t);
  const odd = await f.agentA('/masumi/start_job', { ...f.startInput, identifier_from_purchaser: '0123456789abcde' });
  assert.equal(odd.status, 400);
  assert.equal(f.provider.prepared.length, 0);
  assert.equal(f.store.listPaymentIntents().length, 0);
  const first = await f.agentA('/masumi/start_job', f.startInput);
  assert.equal(first.status, 200);
  const changed = await f.agentA('/masumi/start_job', { ...f.startInput, identifier_from_purchaser: 'abcdef01234567890123' });
  assert.equal(changed.status, 409);
  const unexpected = await f.agentA('/masumi/start_job', { ...f.startInput, input_data: { order_id: f.orderId, amount_minor: 1 } });
  assert.equal(unexpected.status, 400);
  assert.equal(f.provider.prepared.length, 1); assert.equal(f.provider.starts, 0);
});

test('MIP003 prevents another customer from preparing or observing an accepted order', async t => {
  const f = await mipFixture(t);
  const stranger = await f.agentB('/masumi/start_job', f.startInput);
  assert.equal(stranger.status, 403); assert.equal(f.provider.prepared.length, 0);
  const response = await f.agentA('/masumi/start_job', f.startInput);
  assert.equal(response.status, 200); const job = await response.json();
  assert.equal((await f.agentB(`/masumi/status?job_id=${job.id}`)).status, 403);
});

test('MIP003 discovery stays unavailable for local simulation and unconfigured Masumi', async t => {
  const local = await fixture(t), unconfigured = await fixture(t, { PAYMENT_PROVIDER: 'masumi' });
  for (const f of [local, unconfigured]) {
    assert.equal((await (await f.publicCall('/masumi/availability')).json()).status, 'unavailable');
    const response = await f.agentA('/masumi/start_job', { input_data: { order_id: 'nonexistent' }, identifier_from_purchaser: '0123456789abcdef' });
    assert.ok(response.status >= 400 && response.status < 500 || response.status === 503);
    assert.deepEqual(f.store.listPaymentIntents(), []);
  }
});


test('MIP003 concurrent identical starts prepare and persist one seller job without charging the buyer', { timeout: 10000 }, async t => {
  const f = await mipFixture(t);
  let release!: () => void;
  f.provider.preparationGate = new Promise<void>(resolve => { release = resolve; });
  let arrived = 0;
  // Hold the provider until all eight real HTTP requests have reached the server.
  // The server's request event supplies a deterministic barrier without timing sleeps.
  f.server.on('request', req => {
    if (req.headers['x-test-concurrent-job'] === 'true' && ++arrived === 8) release();
  });
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.agentA('/masumi/start_job', f.startInput, { 'x-test-concurrent-job': 'true' })));
  const jobs = [];
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    jobs.push(await response.json());
  }
  for (const job of jobs) assert.deepEqual(job, jobs[0]);
  assert.equal(f.provider.prepared.length, 1); assert.equal(f.provider.starts, 0);
  assert.equal(f.store.listPaymentIntents().length, 1);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM masumi_jobs').get() as { n: number }).n, 1);
  assert.equal(f.store.getOrder(f.orderId).status, 'awaiting_payment');
});

test('customer mandate approval page uses customer-scoped reads and human session CSRF writes', async t => {
  const f = await fixture(t), customerA = await f.login('customer-a'), customerB = await f.login('customer-b');
  const ordersBefore = f.store.listOrders(), paymentsBefore = f.store.listPaymentIntents();
  const page = await f.publicCall('/agent/mandates?mandate_id=unknown');
  assert.equal(page.status, 200); assert.match(await page.text(), /src="\/console.js"/);
  const opened = await f.agentA('/api/agent/cases', { service_spec: service });
  const caseId = (await opened.json()).case.id;
  const proposed = await f.agentA('/api/agent/mandates', {
    case_id: caseId, mode: 'book', service_spec: service, max_total_minor: 250000, max_deposit_minor: 50000,
    payment_mode: 'deposit', latest_service_end: '2026-10-17T22:00:00Z', expires_at: '2026-10-08T10:00:00Z',
    allow_extras: false, currency: 'CZK', network: 'local', asset: 'lovelace', max_asset_quantity: '25000000',
    max_network_fee: '2000000', mapping_version: 'demo-map-v1', seller_id: 'pneu007-demo',
  });
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const mandateId = (await proposed.json()).mandate.id;
  assert.equal((await customerA.call('/api/admin/mandates')).status, 200);
  assert.equal((await (await customerA.call('/api/admin/mandates')).json()).mandates[0].id, mandateId);
  assert.deepEqual((await (await customerB.call('/api/admin/mandates')).json()).mandates, []);
  assert.equal((await customerB.call(`/api/admin/mandates/${mandateId}/approve`, {})).status, 403);
  assert.equal((await f.client({cookie:customerA.cookie})(`/api/admin/mandates/${mandateId}/approve`, {})).status, 403);
  assert.equal((await f.agentA(`/api/admin/mandates/${mandateId}/approve`, {})).status, 403);
  assert.equal((await customerA.call(`/api/admin/mandates/${mandateId}/approve`, {})).status, 200);
  assert.deepEqual(f.store.listOrders(), ordersBefore); assert.deepEqual(f.store.listPaymentIntents(), paymentsBefore);
});

test('Stripe Link checkout is human-approved, owner-bound and fulfilled only by verified provider evidence', async t => {
  const stripeEnv = { STRIPE_SECRET_KEY: 'rk_test_routeFixture', STRIPE_ACCOUNT_ID: 'acct_routeFixture', STRIPE_WEBHOOK_SECRET: 'whsec_routeFixture' };
  let session: Record<string, unknown> | undefined;
  let creates = 0;
  const stripeFetch: typeof fetch = async (url, options) => {
    assert.equal(new URL(String(url)).origin, 'https://api.stripe.com');
    assert.equal(new Headers(options?.headers).get('Stripe-Account'), stripeEnv.STRIPE_ACCOUNT_ID);
    if (String(url).endsWith('/checkout/sessions?limit=1')) return Response.json({ object: 'list', url: '/v1/checkout/sessions', data: [], has_more: false });
    if (options?.method === 'POST') {
      creates++;
      const body = new URLSearchParams(String(options.body));
      const metadata = Object.fromEntries([...body].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value]));
      session = { object: 'checkout.session', id: 'cs_test_routeFixture', mode: 'payment', livemode: false,
        status: 'open', payment_status: 'unpaid', amount_total: Number(body.get('line_items[0][price_data][unit_amount]')),
        currency: 'czk', client_reference_id: body.get('client_reference_id'), metadata,
        expires_at: Number(body.get('expires_at')), created: Math.floor(clock().getTime() / 1000),
        url: 'https://checkout.stripe.com/c/pay/cs_test_routeFixture', payment_intent: null };
    }
    return Response.json(session);
  };
  const f = await fixture(t, stripeEnv, { stripeFetch });
  const a = await f.login('customer-a'), b = await f.login('customer-b');
  const order = await createHumanOrder(a.call);
  const route = `/api/orders/${order.id}/link-checkout`;
  assert.equal((await f.publicCall(route, { payment_mode: 'deposit', confirm: true })).status, 401);
  assert.equal((await b.call(route, { payment_mode: 'deposit', confirm: true })).status, 403);
  assert.equal((await f.agentA(route, { payment_mode: 'deposit', confirm: true })).status, 403);
  assert.equal((await a.call(route, { payment_mode: 'deposit', confirm: false })).status, 400);
  assert.equal((await a.call(route, { payment_mode: 'deposit', confirm: true, amount_minor: 1 })).status, 400);
  assert.equal(creates, 0);
  const config = await (await f.publicCall('/api/payments/config')).json();
  assert.equal(config.stripe_link.ready, true);
  assert.ok(!JSON.stringify(config).includes(stripeEnv.STRIPE_SECRET_KEY));
  const started = await a.call(route, { payment_mode: 'deposit', confirm: true });
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json()).stripe_checkout.state, 'open');
  assert.equal((await a.call(route, { payment_mode: 'deposit', confirm: true })).status, 200);
  assert.equal(creates, 1);
  assert.equal((await a.call(`/api/orders/${order.id}/checkout`, { payment_mode: 'deposit', confirm: true, max_network_fee: '2000000' })).status, 409);
  assert.equal((await b.call(`/api/orders/${order.id}/link-payment`)).status, 403);
  assert.equal(f.store.calendar().filter(value => value.order_id === order.id).length, 0);
  Object.assign(session!, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_routeFixture', url: null });
  const raw = JSON.stringify({ id: 'evt_routeFixture', type: 'checkout.session.completed', livemode: false, data: { object: session } });
  const timestamp = Math.floor(clock().getTime() / 1000);
  const { createHmac } = await import('node:crypto');
  const signature = `t=${timestamp},v1=${createHmac('sha256', stripeEnv.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex')}`;
  const deliver = (body: string) => fetch(f.base + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body });
  assert.equal((await deliver(raw + ' ')).status, 400);
  assert.equal((await deliver(raw)).status, 200);
  assert.equal((await deliver(raw)).status, 200);
  const final = await (await a.call(`/api/orders/${order.id}`)).json();
  assert.equal(final.stripe_checkout.state, 'paid');
  assert.equal(final.booking.status, 'confirmed');
  assert.equal(final.payment, null);
  assert.equal(final.order.balance_minor, 197200);
  assert.equal(f.store.listPaymentIntents().length, 0);
  assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(order.id), { n: 1 });
});
