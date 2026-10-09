// Scripted HTTP regression evidence. This is not a live GrokBot or external identity-provider proof.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLegacyConfig } from '../src/config.js';
import { createLegacy } from '../src/server.js';
import { LocalDemoProvider } from '../../../packages/payments/index.js';
import { clock, freshFixture, json, password, ready, service, type Client, type FreshFixture } from './handoru-fixture.js';

const prefix = '/api/handle/customer/v1';
const secretA = 'synthetic-customer-service-garage-A-0123456789';
const secretB = 'synthetic-customer-service-garage-B-0123456789';
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'A2A-Version': '1.0' });
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function httpClient(origin: string, defaults: Record<string, string> = {}): Client {
  return (path, body, headers = {}) => fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...defaults, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
}
async function fixture(t: TestContext) {
  // Reserve the issuer by binding it, then attach its app once both trusted business origins exist.
  const central = createServer();
  await new Promise<void>(resolve => central.listen(0, '127.0.0.1', resolve));
  const centralOrigin = `http://127.0.0.1:${(central.address() as AddressInfo).port}`;
  let offline = false;
  let mutate: ((value: any) => unknown) | undefined;
  const identityFetch: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error', 'credentials must never follow an issuer redirect');
    if (offline) throw new Error('synthetic issuer outage');
    const response = await fetch(input, init);
    if (mutate && String(input).endsWith('/introspect') && response.ok) return Response.json(mutate(await response.json()));
    return response;
  };
  const a = await freshFixture(t, { unified: true, customerIdentityFetch: identityFetch,
    env: { HANDLE_CUSTOMER_ISSUER_URL: centralOrigin, HANDLE_CUSTOMER_BUSINESS_ID: 'garage-a', HANDLE_CUSTOMER_SERVICE_SECRET: secretA } });
  const b = await freshFixture(t, { unified: true, customerIdentityFetch: identityFetch,
    env: { HANDLE_CUSTOMER_ISSUER_URL: centralOrigin, HANDLE_CUSTOMER_BUSINESS_ID: 'garage-b', HANDLE_CUSTOMER_SERVICE_SECRET: secretB } });
  const dir = mkdtempSync(join(tmpdir(), 'handle-customer-issuer-'));
  const config = loadLegacyConfig({ ...a.cfg.env, LEGACY_PUBLIC_URL: centralOrigin,
    LEGACY_PORT: String((central.address() as AddressInfo).port), LEGACY_DB_PATH: join(dir, 'issuer.sqlite'),
    LEGACY_RELAY_DB_PATH: join(dir, 'unused-relay.sqlite'), HANDLE_CUSTOMER_IDENTITY_ENABLED: 'true',
    HANDLE_CUSTOMER_BUSINESS_ID: undefined, HANDLE_CUSTOMER_SERVICE_SECRET: undefined,
    HANDLE_CUSTOMER_BUSINESSES: JSON.stringify([
      { business_id: 'garage-a', resource_url: a.base, service_secret: secretA },
      { business_id: 'garage-b', resource_url: b.base, service_secret: secretB },
    ]) });
  const options = { now: clock, paymentProvider: new LocalDemoProvider({ now: clock }) };
  let issuer = createLegacy(config, options);
  central.on('request', issuer.app);
  t.after(async () => { await stop(central); await issuer.close(); rmSync(dir, { recursive: true, force: true }); });
  const restartIssuer = async () => {
    central.removeAllListeners('request'); await issuer.close(); issuer = createLegacy(config, options); central.on('request', issuer.app);
  };
  const publicCall = httpClient(centralOrigin);
  const signup = async (email = 'customer001@example.test') => {
    const response = await publicCall(`${prefix}/signup`, { email, password, name: 'Approved Customer', phone: '+420123456789' });
    const data = await json(response, 201), cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { data, cookie, csrf: data.csrf_token as string, call: httpClient(centralOrigin, { cookie, 'x-csrf-token': data.csrf_token }) };
  };
  const connect = async (human: Awaited<ReturnType<typeof signup>>, scopes = ['a2a', 'customer.tools'], fields: string[] = []) => {
    const registration = await json(await publicCall(`${prefix}/connections/register`, { name: 'Scripted personal agent' }), 201);
    await json(await human.call(`${prefix}/connections/${registration.connection_id}/approve`, {
      user_code: registration.user_code, scopes, shared_fields: fields,
    }));
    const delegation = await json(await publicCall(`${prefix}/connections/exchange`, { device_code: registration.device_code }));
    const renew = (businessId: string) => publicCall(`${prefix}/token`, { business_id: businessId }, bearer(delegation.delegation_token));
    return { registration, delegation, renew };
  };
  return { a, b, centralOrigin, publicCall, signup, connect, restartIssuer, get issuer() { return issuer; },
    setOffline: (value: boolean) => { offline = value; }, setMutate: (value?: typeof mutate) => { mutate = value; } };
}
function rpc(method: string, params: unknown) { return { jsonrpc: '2.0', id: randomUUID(), method, params }; }
function message(text: string, metadata: Record<string, unknown> = {}) {
  return rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], metadata }, configuration: { returnImmediately: true } });
}
async function dialogue(f: FreshFixture, business: Awaited<ReturnType<typeof ready>>, token: string) {
  const endpoint = new URL(business.relay.endpoint).pathname;
  const customer = f.client(bearer(token));
  const sent = await json(await customer(endpoint, message('Synthetic request: quote four tyres.')));
  const taskId = sent.result?.task?.id ?? sent.result?.id;
  assert.ok(taskId, JSON.stringify(sent));
  const opened = (await json(await customer('/api/agent/cases', { relay_task_id: taskId, service_spec: service }), 201)).case;
  const quoted = await json(await business.agent(`/api/agent/cases/${opened.id}/quotes`, { slot_id: 'slot-main', discount_bps: 300 }, { 'idempotency-key': `quote-${opened.id}` }), 201);
  let claim: any;
  for (let attempt = 0; attempt < 40 && !claim; attempt++) {
    const inbox = await json(await business.agent(`/relay/${business.relay.id}/bot/inbox`));
    claim = inbox.items.find((item: any) => item.task_id === taskId);
    if (!claim) await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(claim, 'customer request reaches this business agent inbox');
  await json(await business.agent(`/relay/${business.relay.id}/bot/reply`, {
    work_item_id: claim.work_item_id, lease_token: claim.lease_token, claim_generation: claim.claim_generation,
    text: `Scripted offer ${quoted.quote.id}`, state: 'completed',
  }));
  const task = await json(await customer(endpoint, rpc('GetTask', { id: taskId })));
  assert.match(JSON.stringify(task), new RegExp(quoted.quote.id));
  return { customer, opened, quoted, taskId, endpoint };
}
function mandate(caseId: string, maxTotal = 250000) {
  return { case_id: caseId, mode: 'book', service_spec: service, max_total_minor: maxTotal, max_deposit_minor: 50000,
    payment_mode: 'deposit', latest_service_end: '2026-10-20T22:00:00Z', expires_at: new Date(clock().getTime() + 3600000).toISOString(),
    allow_extras: false, currency: 'CZK', network: 'local', asset: 'lovelace', max_asset_quantity: '25000000',
    max_network_fee: '2000000', mapping_version: 'demo-map-v1', seller_id: 'pneu007-demo' };
}

// One shared run lets the acceptance sequence prove persisted state and revocation of the same original purchase.
test('T43–T50: one Handle customer operates two isolated business origins without local signup', async t => {
  const f = await fixture(t);
  const [businessA, businessB] = await Promise.all([ready(f.a), ready(f.b)]);
  const legacyCustomer = f.a.system.store.db.prepare('SELECT email FROM customers WHERE id=?').get('customer-001') as { email: string };
  const human = await f.signup(legacyCustomer.email);
  const connection = await f.connect(human);
  const [tokenA, tokenB] = await Promise.all([json(await connection.renew('garage-a')), json(await connection.renew('garage-b'))]);
  const [offerA, offerB] = await Promise.all([dialogue(f.a, businessA, tokenA.access_token), dialogue(f.b, businessB, tokenB.access_token)]);
  const proposal = await json(await offerA.customer('/api/agent/mandates', mandate(offerA.opened.id)), 201);
  const reviewPath = `${prefix}/businesses/garage-a/mandates/${proposal.mandate.id}`;
  const review = await json(await human.call(`${reviewPath}?connection_id=${connection.registration.connection_id}`));
  let originalOrderId = '', originalIntentId = '', originalBookingId = '';

  await t.test('T43: two A2A offers and one separately human-approved Pneu simulation', async () => {
    assert.notEqual(f.a.base, f.b.base); assert.notEqual(tokenA.access_token, tokenB.access_token);
    assert.equal(tokenA.resource_url, f.a.base); assert.equal(tokenB.resource_url, f.b.base);
    assert.notEqual(offerA.opened.customer_id, offerB.opened.customer_id);
    assert.notEqual(offerA.quoted.quote.id, offerB.quoted.quote.id);
    assert.equal((await json(await human.call(`${prefix}/access`))).connections.length, 1);
    assert.equal(f.a.system.store.listPaymentIntents().length, 0);
    const accept = { quote_id: offerA.quoted.quote.id, mandate_id: proposal.mandate.id };
    assert.equal((await offerA.customer(`/api/agent/cases/${offerA.opened.id}/accept`, accept)).status, 403);
    const url = new URL(proposal.approval_url); assert.equal(url.origin, f.centralOrigin);
    const approval = await json(await human.call(`${reviewPath}/approve`, { connection_id: connection.registration.connection_id, mandate_hash: review.mandate_hash }));
    assert.equal(approval.mandate.status, 'approved');
    const accepted = await json(await offerA.customer(`/api/agent/cases/${offerA.opened.id}/accept`, accept));
    const purchase = await json(await businessA.agent(`/api/agent/orders/${accepted.order.id}/checkout`, {}, { 'idempotency-key': 'single-handle-customer-checkout' }));
    const replay = await json(await businessA.agent(`/api/agent/orders/${accepted.order.id}/checkout`, {}, { 'idempotency-key': 'single-handle-customer-checkout' }));
    assert.equal(purchase.intent.provider, 'local_demo'); assert.equal(purchase.simulation, true);
    assert.equal(purchase.booking.status, 'confirmed'); assert.equal(purchase.intent.authorization.mandate_id, proposal.mandate.id);
    assert.equal(purchase.intent.intent_id, replay.intent.intent_id);
    originalOrderId = accepted.order.id; originalIntentId = purchase.intent.intent_id; originalBookingId = purchase.booking.id;
    assert.equal(f.a.system.store.listPaymentIntents().length, 1);
    assert.equal(f.a.system.store.calendar().filter(row => row.order_id === originalOrderId).length, 1);
    assert.equal(f.b.system.store.listPaymentIntents().length, 0);
  });

  await t.test('T44: audience, delegation, scopes and unavailable issuer fail on both surfaces', async () => {
    for (const token of [tokenA.access_token, connection.delegation.delegation_token]) {
      assert.equal((await f.b.client(bearer(token))('/api/agent/cases', { service_spec: service })).status, 401);
      assert.equal((await f.b.client(bearer(token))(offerB.endpoint, message('foreign credential'))).status, 401);
    }
    for (const [scopes, forbidden, allowed] of [
      [['a2a'], '/api/agent/cases', offerA.endpoint],
      [['customer.tools'], offerA.endpoint, '/api/agent/cases'],
    ] as const) {
      const scoped = await f.connect(human, [...scopes]);
      const token = await json(await scoped.renew('garage-a')), client = f.a.client(bearer(token.access_token));
      assert.equal((await client(forbidden, forbidden === '/api/agent/cases' ? { service_spec: service } : message('scope denied'))).status, 403);
      if (scopes[0] === 'customer.tools') {
        for (const endpoint of [forbidden.replace('/a2a', '/A2A'), forbidden.replace('/relay/', '/RELAY/'), '/A2A/jsonrpc']) {
          assert.equal((await client(endpoint, message('case-insensitive scope denied'))).status, 403);
        }
      }
      assert.equal((await client(allowed, allowed === '/api/agent/cases' ? { service_spec: service } : message('scope allowed'))).status, allowed === '/api/agent/cases' ? 201 : 200);
    }
    for (const update of [
      { iss: 'https://untrusted.example' }, { aud: f.b.base }, { business_id: 'garage-b' },
      { connection_id: '' }, { exp: clock().getTime() / 1000 }, { scope: 'a2a customer.tools owner' },
    ]) {
      f.setMutate(value => ({ ...value, ...update }));
      assert.equal((await offerA.customer('/api/agent/cases', { service_spec: service })).status, 401);
      assert.equal((await offerA.customer(offerA.endpoint, message('invalid authority'))).status, 401);
    }
    f.setMutate(); f.setOffline(true);
    try {
      assert.equal((await offerA.customer('/api/agent/cases', { service_spec: service })).status, 503);
      assert.equal((await offerA.customer(offerA.endpoint, message('issuer offline'))).status, 503);
    } finally { f.setOffline(false); }
  });

  await t.test('T45: only independent human consent permits exchange and approval', async () => {
    const pending = await json(await f.publicCall(`${prefix}/connections/register`, { name: 'Unapproved agent' }), 201);
    const approvalPath = `${prefix}/connections/${pending.connection_id}/approve`;
    const consent = { user_code: pending.user_code, scopes: ['a2a'], shared_fields: [] };
    assert.equal((await f.publicCall(`${prefix}/connections/exchange`, { device_code: pending.device_code })).status, 400);
    assert.equal((await f.publicCall(approvalPath, consent)).status, 401);
    assert.equal((await f.publicCall(approvalPath, consent, { cookie: human.cookie })).status, 403);
    for (const token of [tokenA.access_token, connection.delegation.delegation_token, businessA.token]) {
      assert.equal((await human.call(approvalPath, consent, bearer(token))).status, 403);
    }
    assert.equal((await f.publicCall(approvalPath, consent, { cookie: businessA.legacyOwner.cookie, 'x-csrf-token': businessA.legacyOwner.csrf })).status, 401);
    await json(await human.call(approvalPath, consent));
    assert.equal((await human.call(approvalPath, consent)).status, 403);
    await json(await f.publicCall(`${prefix}/connections/exchange`, { device_code: pending.device_code }));
    assert.equal((await f.publicCall(`${prefix}/connections/exchange`, { device_code: pending.device_code })).status, 400);
    assert.equal((await offerA.customer(`${businessA.path}/owner/connections/${businessA.connectionId}/authorize-operation`, {})).status, 403);
    const expired = await json(await f.publicCall(`${prefix}/connections/register`, { name: 'Expired consent request' }), 201);
    f.issuer.store.db.prepare('UPDATE customer_identity_connections SET request_expires_at=? WHERE id=?').run(clock().getTime() - 1, expired.connection_id);
    assert.equal((await human.call(`${prefix}/connections/${expired.connection_id}/approve`, { ...consent, user_code: expired.user_code })).status, 403);

  });

  await t.test('T46: concurrent operations, renewal, changed email and restart retain mappings without email merge', async () => {
    const opened = await Promise.all(Array.from({ length: 5 }, async () => (await json(await offerA.customer('/api/agent/cases', { service_spec: service }), 201)).case));
    assert.ok(opened.every(value => value.customer_id === offerA.opened.customer_id));
    assert.notEqual(offerA.opened.customer_id, 'customer-001', 'shared legacy email never links existing history');
    assert.equal((f.a.system.store.db.prepare('SELECT count(*) n FROM customer_identity_mappings').get() as { n: number }).n, 1);
    const contactConsent = await f.connect(human, ['a2a', 'customer.tools'], ['email']);
    const contactToken = await json(await contactConsent.renew('garage-a'));
    const sameEmail = (await json(await f.a.client(bearer(contactToken.access_token))('/api/agent/cases', { service_spec: service }), 201)).case;
    assert.equal(sameEmail.customer_id, offerA.opened.customer_id);
    assert.deepEqual(f.a.system.store.db.prepare('SELECT name,email,phone FROM customers WHERE id=?').get(sameEmail.customer_id),
      { name: '', email: legacyCustomer.email, phone: '' });
    assert.notEqual(sameEmail.customer_id, 'customer-001');
    const legacyOrder = f.a.system.store.listOrders().find(order => order.customer_id === 'customer-001');
    assert.ok(legacyOrder, 'fixture includes an existing customer order to protect');
    assert.equal((await f.a.client(bearer(contactToken.access_token))(`/api/agent/orders/${legacyOrder.id}`)).status, 403);


    await json(await human.call(`${prefix}/profile`, { email: 'changed@example.test' }));
    await f.restartIssuer(); await f.a.restart(); await f.b.restart();
    const renewed = await json(await connection.renew('garage-a'));
    const reopened = (await json(await f.a.client(bearer(renewed.access_token))('/api/agent/cases', { service_spec: service }), 201)).case;
    assert.equal(reopened.customer_id, offerA.opened.customer_id);
    assert.equal((await offerA.customer('/api/agent/cases', { service_spec: service, customer_id: 'customer-001' })).status, 400);
    const altered = await json(await offerA.customer(offerA.endpoint, message('payload identity cannot replace auth', { customer_id: 'customer-001', agent_id: 'forged-agent' })));
    const taskId = altered.result?.task?.id ?? altered.result?.id;
    const correlated = (await json(await offerA.customer('/api/agent/cases', { service_spec: service, relay_task_id: taskId }), 201)).case;
    assert.equal(correlated.customer_id, offerA.opened.customer_id); assert.equal(correlated.customer_agent_id, offerA.opened.customer_agent_id);
  });

  await t.test('T47: profiles, histories and personal connections remain isolated', async () => {
    const profile = f.a.system.store.db.prepare('SELECT name,email,phone FROM customers WHERE id=?').get(offerA.opened.customer_id);
    assert.deepEqual(profile, { name: '', email: '', phone: '' });
    const snapshot = f.a.system.store.db.prepare('SELECT name,email,phone FROM order_contact_snapshots WHERE order_id=?').get(originalOrderId);
    assert.deepEqual(snapshot, { name: '', email: '', phone: '' });
    assert.equal((await offerB.customer(`/api/agent/cases/${offerA.opened.id}`)).status, 404);
    const otherHuman = await f.signup('other@example.test'), otherConnection = await f.connect(otherHuman);
    const otherToken = await json(await otherConnection.renew('garage-a'));
    assert.equal((await f.a.client(bearer(otherToken.access_token))(`/api/agent/cases/${offerA.opened.id}`)).status, 403);
    assert.equal((await otherHuman.call(`${reviewPath}?connection_id=${connection.registration.connection_id}`)).status, 403);
    assert.equal((await connection.renew('garage-a')).status, 200);
    assert.equal((await f.publicCall(`${prefix}/token`, { business_id: 'garage-a', scopes: ['owner'], shared_fields: ['email'] }, bearer(connection.delegation.delegation_token))).status, 400);
  });

  await t.test('T49: mandates require the reviewed hash, correct human, business, connection and budget', async () => {
    const introspection = await json(await f.publicCall(`${prefix}/introspect`, { token: tokenA.access_token }, bearer(secretA)));
    const bridgeContext = { sub: introspection.sub, connection_id: introspection.connection_id, grant_id: introspection.grant_id, mandate_hash: review.mandate_hash };
    assert.equal((await f.a.publicCall(`/api/customer-identity/mandates/${proposal.mandate.id}/approve`, bridgeContext, bearer(secretA))).status, 403,
      'Possessing a business service credential and grant context never substitutes for a human decision');
    // Exercise transport replay with a central-only test-issued decision; production minting stays behind the human CSRF proxy.
    const ticket = f.issuer.customerIdentity.issuer!.createMandateDecision(human.data.customer.id, 'garage-a', connection.registration.connection_id, proposal.mandate.id, review.mandate_hash);
    const bridgeApproval = { ...bridgeContext, decision_ticket: ticket };
    await json(await f.a.publicCall(`/api/customer-identity/mandates/${proposal.mandate.id}/approve`, bridgeApproval, bearer(secretA)));
    assert.equal((await f.a.publicCall(`/api/customer-identity/mandates/${proposal.mandate.id}/approve`, bridgeApproval, bearer(secretA))).status, 401,
      'A consumed exact human decision cannot be replayed');

    assert.equal((await human.call(`${reviewPath}/approve`, { connection_id: connection.registration.connection_id, mandate_hash: '0'.repeat(64) })).status, 409);
    assert.equal((await f.publicCall(`${reviewPath}/approve`, { connection_id: connection.registration.connection_id, mandate_hash: review.mandate_hash }, { cookie: human.cookie })).status, 403);
    assert.equal((await offerA.customer(`/api/admin/mandates/${proposal.mandate.id}/approve`, {})).status, 403);
    assert.equal((await offerA.customer(`/api/customer-identity/mandates/${proposal.mandate.id}/approve`, { connection_id: connection.registration.connection_id, mandate_hash: review.mandate_hash })).status, 403);
    assert.equal((await human.call(`${prefix}/businesses/garage-b/mandates/${proposal.mandate.id}?connection_id=${connection.registration.connection_id}`)).status, 404);
    assert.equal((await offerB.customer(`/api/agent/cases/${offerB.opened.id}/accept`, { quote_id: offerB.quoted.quote.id, mandate_id: proposal.mandate.id })).status, 404);
    const replacement = await f.connect(human), replacementToken = await json(await replacement.renew('garage-a'));
    assert.equal((await human.call(`${reviewPath}?connection_id=${replacement.registration.connection_id}`)).status, 403);
    const low = await json(await offerB.customer('/api/agent/mandates', mandate(offerB.opened.id, 1)), 201);
    const lowPath = `${prefix}/businesses/garage-b/mandates/${low.mandate.id}`;
    const lowReview = await json(await human.call(`${lowPath}?connection_id=${connection.registration.connection_id}`));
    await json(await human.call(`${lowPath}/approve`, { connection_id: connection.registration.connection_id, mandate_hash: lowReview.mandate_hash }));
    assert.equal((await offerB.customer(`/api/agent/cases/${offerB.opened.id}/accept`, { quote_id: offerB.quoted.quote.id, mandate_id: low.mandate.id })).status, 403);
    assert.ok(replacementToken.access_token); assert.equal(f.b.system.store.listPaymentIntents().length, 0);
  });

  await t.test('T50: renewal and restart preserve the original customer, mandate, booking and payment intent', async () => {
    const renewed = await json(await connection.renew('garage-a'));
    assert.notEqual(renewed.access_token, tokenA.access_token); assert.ok(renewed.expires_in > 0 && renewed.expires_in <= 600);
    const restored = await json(await f.a.client(bearer(renewed.access_token))(`/api/agent/cases/${offerA.opened.id}`));
    assert.equal(restored.case.customer_id, offerA.opened.customer_id); assert.equal(restored.case.mandate_id, proposal.mandate.id);
    assert.equal(restored.case.order_id, originalOrderId);
    const purchase = await json(await businessA.agent(`/api/agent/orders/${originalOrderId}/checkout`, {}, { 'idempotency-key': 'single-handle-customer-checkout' }));
    assert.equal(purchase.intent.intent_id, originalIntentId); assert.equal(purchase.booking.id, originalBookingId);
    assert.equal(f.a.system.store.listPaymentIntents().length, 1);
    assert.equal((await f.a.customer('/api/agent/cases', { service_spec: service })).status, 201, 'legacy per-business customer credential remains supported');
    const expiring = await f.connect(human), expiringToken = await json(await expiring.renew('garage-a'));
    f.issuer.store.db.prepare('UPDATE customer_identity_connections SET expires_at=? WHERE id=?').run(clock().getTime() - 1, expiring.registration.connection_id);
    assert.equal((await expiring.renew('garage-a')).status, 401);
    assert.equal((await f.a.client(bearer(expiringToken.access_token))('/api/agent/cases', { service_spec: service })).status, 401);

  });

  await t.test('T48: revoking one grant then the personal connection denies the next operations and renewal across restart', async () => {
    const access = await json(await human.call(`${prefix}/access`));
    const grantA = access.grants.find((value: any) => value.business_id === 'garage-a' && value.connection_id === connection.registration.connection_id);
    await json(await human.call(`${prefix}/grants/${grantA.id}/revoke`, {}));
    assert.equal((await offerA.customer('/api/agent/cases', { service_spec: service })).status, 401);
    assert.equal((await offerA.customer(offerA.endpoint, message('revoked A'))).status, 401);
    assert.equal((await connection.renew('garage-a')).status, 403);
    const stillB = await json(await connection.renew('garage-b'));
    assert.equal((await f.b.client(bearer(stillB.access_token))('/api/agent/cases', { service_spec: service })).status, 201);
    assert.equal((await f.b.client(bearer(stillB.access_token))(offerB.endpoint, message('B remains allowed'))).status, 200);
    await json(await human.call(`${prefix}/connections/${connection.registration.connection_id}/revoke`, {}));
    await f.restartIssuer(); await f.a.restart(); await f.b.restart();
    for (const [garage, offer, businessId] of [[f.a, offerA, 'garage-a'], [f.b, offerB, 'garage-b']] as const) {
      assert.equal((await offer.customer('/api/agent/cases', { service_spec: service })).status, 401);
      assert.equal((await offer.customer(offer.endpoint, message('connection revoked'))).status, 401);
      assert.equal((await connection.renew(businessId)).status, 401);
      assert.equal((garage.system.store.db.prepare('SELECT count(*) n FROM customer_identity_mappings WHERE customer_id=?').get(offer.opened.customer_id) as { n: number }).n, 1);
    }
    const preserved = f.a.system.store.getPaymentIntent(originalIntentId);
    assert.equal(preserved.intent_id, originalIntentId); assert.equal(preserved.order_id, originalOrderId);
    assert.equal(f.a.system.store.calendar().find(row => row.order_id === originalOrderId)!.id, originalBookingId);
    assert.equal(f.a.system.store.listPaymentIntents().length, 1);
  });
});
