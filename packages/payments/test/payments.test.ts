import { validateRequest } from '../src/common.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PaymentRequest } from '../../contracts/index.js';
import { LegacyStore } from '../../demo-garage/index.js';
import { createPaymentProvider, LocalDemoProvider, MasumiProvider, PAYMENT_SKUS, paymentProviderStatus, readMasumiConfig,
  selectPaymentSku, type MasumiConfig } from '../index.js';

const time = new Date('2026-10-08T08:00:00.000Z');
const seller = 'f'.repeat(56);
const agent = `${'a'.repeat(56)}0070`;
const resultHash = createHash('sha256').update('voucher').digest('hex');
const withdrawalHash = 'c'.repeat(64);
function request(provider: 'local_demo' | 'masumi' = 'masumi'): PaymentRequest {
  const network = provider === 'masumi' ? 'Preprod' : 'local';
  const sellerId = provider === 'masumi' ? seller : 'pneu007-demo';
  return {
    intent_id: 'intent-1', order_id: 'order-1', quote_id: 'quote-1', customer_id: 'customer-1',
    payment_mode: 'deposit', amount_minor: 50000, provider, network, sku: 'deposit-500',
    asset: 'lovelace', asset_quantity: '5000000', max_network_fee: '1000000',
    input_hash: createHash('sha256').update('order-1').digest('hex'), identifier_from_purchaser: '11223344556677889900',
    seller_id: sellerId, created_at: time.toISOString(),
    authorization: { kind: 'agent_mandate', actor_id: 'buyer', customer_id: 'customer-1', quote_id: 'quote-1',
      quote_version: 1, payment_mode: 'deposit', max_total_minor: 247200, max_deposit_minor: 50000,
      network, seller_id: sellerId, asset: 'lovelace', asset_quantity: '5000000', max_network_fee: '1000000',
      mapping_version: 'demo-map-v1', mandate_id: 'mandate-1', approved_at: time.toISOString() },
  };
}

type RecordData = Record<string, unknown>;
function fixture(recordRequest = request()) {
  const deadlines = {
    payByTime: String(time.getTime() + 20 * 60000), submitResultTime: String(time.getTime() + 60 * 60000),
    unlockTime: String(time.getTime() + 90 * 60000), externalDisputeUnlockTime: String(time.getTime() + 120 * 60000),
  };
  const common = { ...deadlines, id: 'provider-payment-1', blockchainIdentifier: 'signed-blockchain-identifier', inputHash: recordRequest.input_hash,
    PaymentSource: { network: 'Preprod', paymentType: 'Web3CardanoV1', policyId: agent.slice(0, 56), smartContractAddress: 'addr_test1contract' },
    onChainState: null, resultHash: '', NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null },
    CurrentTransaction: null, TransactionHistory: [], WithdrawnForSeller: [], WithdrawnForBuyer: [] };
  const payment: RecordData = { ...common, RequestedFunds: [{ unit: '', amount: recordRequest.asset_quantity }],
    SmartContractWallet: { id: 'seller-wallet', walletVkey: seller, walletAddress: 'addr_test1seller' },
    metadata: JSON.stringify({ intent_id: recordRequest.intent_id, order_id: recordRequest.order_id, sku: recordRequest.sku }) };
  const purchase: RecordData = { ...common, id: 'provider-purchase-1', PaidFunds: [{ unit: '', amount: recordRequest.asset_quantity }],
    SellerWallet: null, NextAction: { requestedAction: 'FundsLockingRequested', errorType: null } };
  return { payment, purchase };
}
function funded(purchase: RecordData, state = 'FundsLocked'): void {
  purchase.onChainState = state;
  purchase.SellerWallet = { id: 'seller-wallet', walletVkey: seller };
  purchase.NextAction = { requestedAction: 'None', errorType: null };
  purchase.CurrentTransaction = { id: 'chain-tx', status: 'Confirmed', txHash: 'b'.repeat(64) };
}

function settlementFixture(recordRequest: PaymentRequest) {
  const ada = (quantity: string) => [{ unit: 'lovelace', quantity }];
  const datumHash = 'd'.repeat(64); const feeDatumHash = 'e'.repeat(64);
  const fields: RecordData[] = Array.from({ length: 16 }, () => ({ int: 0 }));
  fields[1] = { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: seller }] }] };
  fields[5] = { bytes: recordRequest.identifier_from_purchaser };
  fields[7] = { bytes: recordRequest.input_hash }; fields[8] = { bytes: resultHash };
  fields[15] = { constructor: 1, fields: [] };
  for (const [index, minutes] of [[9, 20], [10, 60], [11, 90], [12, 120]]) fields[index] = { int: time.getTime() + minutes * 60000 };
  return {
    fail: false,
    tx: { hash: withdrawalHash, block: 'a'.repeat(64), block_height: 100, valid_contract: true, fees: '497499' },
    utxos: { hash: withdrawalHash, inputs: [
      { tx_hash: 'b'.repeat(64), output_index: 0, address: 'addr_test1contract', amount: ada('5000000'),
        collateral: false, reference: false, data_hash: datumHash, inline_datum: 'd87980' },
      { tx_hash: 'a'.repeat(64), output_index: 1, address: 'addr_test1seller', amount: ada('24231626'), collateral: false, reference: false },
      { tx_hash: 'a'.repeat(64), output_index: 1, address: 'addr_test1seller', amount: ada('24231626'), collateral: true, reference: false },
    ], outputs: [
      { output_index: 0, address: 'addr_test1seller', amount: ada('3564770'), collateral: false, data_hash: null, inline_datum: null },
      { output_index: 1, address: 'addr_test1fee', amount: ada('1435230'), collateral: false, data_hash: feeDatumHash, inline_datum: 'd87980' },
      { output_index: 2, address: 'addr_test1seller', amount: ada('23734127'), collateral: false, data_hash: null, inline_datum: null },
      { output_index: 3, address: 'addr_test1seller', amount: ada('19231626'), collateral: true, data_hash: null, inline_datum: null },
    ] },
    datum: { json_value: { constructor: 0, fields } },
    feeDatum: { json_value: { constructor: 0, fields: [{ bytes: 'b'.repeat(64) }, { int: 0 }] } },
    datumHash, feeDatumHash,
  };
}

function server(recordRequest = request(), overrides: Partial<MasumiConfig> = {}) {
  const initial = fixture(recordRequest);
  const chain = settlementFixture(recordRequest);
  let payment: RecordData | undefined;
  let purchase: RecordData | undefined;
  let lostPurchaseResponse = false;
  let lostPaymentResponse = false;
  let hideSeller = false;
  let hideBuyer = false;
  let walletBalance = 6000000;
  const calls: Array<{ url: string; init?: RequestInit; body?: RecordData }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.toString(), init, body });
    const reply = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    if (url.origin === 'https://cardano-preprod.blockfrost.io') {
      if (chain.fail) throw new Error('unavailable preprodPrivateTestKey');
      const resources: Record<string, unknown> = {
        [`/api/v0/txs/${withdrawalHash}`]: chain.tx,
        [`/api/v0/txs/${withdrawalHash}/utxos`]: chain.utxos,
        [`/api/v0/scripts/datum/${chain.datumHash}`]: chain.datum,
        [`/api/v0/scripts/datum/${chain.feeDatumHash}`]: chain.feeDatum,
      };
      assert.ok(url.pathname in resources, url.pathname);
      return new Response(JSON.stringify(resources[url.pathname]));
    }
    if (url.pathname.endsWith('/payment/') && init?.method === 'GET') return reply({ Payments: payment ? [payment] : [] });
    if (url.pathname.endsWith('/payment/') && init?.method === 'POST') {
      payment = structuredClone(initial.payment);
      if (lostPaymentResponse) throw new Error('lost seller response');
      return reply(payment);
    }
    if (url.pathname.endsWith('/payment/resolve-blockchain-identifier')) return payment && !hideSeller ? reply(payment) : new Response('', { status: 404 });
    if (url.pathname.endsWith('/purchase/resolve-blockchain-identifier')) return purchase && !hideBuyer ? reply(purchase) : new Response('', { status: 404 });
    if (url.pathname.endsWith('/payment-source/')) return reply({ PaymentSources: [{ network: 'Preprod', policyId: agent.slice(0, 56),
      feeRatePermille: 50, FeeReceiverNetworkWallet: { walletAddress: 'addr_test1fee' }, PurchasingWallets: [{ walletAddress: 'addr_test_buyer' }] }] });
    if (url.pathname.endsWith('/utxos/')) return reply({ Utxos: [{ address: 'addr_test_buyer', Amounts: [{ unit: '', quantity: walletBalance }] }] });
    if (url.pathname.endsWith('/purchase/')) {
      if (purchase) return new Response('', { status: 409 });
      purchase = structuredClone(initial.purchase);
      if (lostPurchaseResponse) throw new Error('connection lost secret-token');
      return reply(purchase);
    }
    if (url.pathname.endsWith('/payment/submit-result')) {
      assert.ok(payment && purchase);
      payment.resultHash = body.submitResultHash;
      purchase.resultHash = body.submitResultHash;
      funded(purchase, 'ResultSubmitted');
      payment.onChainState = 'ResultSubmitted';
      return reply(payment);
    }
    if (url.pathname.endsWith('/purchase/request-refund')) {
      assert.ok(purchase); funded(purchase, 'RefundRequested'); return reply(purchase);
    }
    if (url.pathname.endsWith('/payment/authorize-refund')) {
      assert.ok(payment && purchase);
      funded(purchase, 'RefundWithdrawn'); purchase.WithdrawnForBuyer = [{ unit: '', amount: recordRequest.asset_quantity }];
      return reply(payment);
    }
    throw new Error(`Unexpected mocked HTTP path: ${url.pathname}`);
  };
  const config: MasumiConfig = { sellerUrl: 'http://127.0.0.1:3001/api/v1', buyerUrl: 'http://127.0.0.1:3002/api/v1', sellerToken: 'seller-secret',
    buyerToken: 'buyer-secret', sellerVkey: seller, skus: { 'deposit-500': agent }, buyerWalletAddress: 'addr_test_buyer',
    dedicatedBuyerWallet: true, buyerLifecycleIsolated: true, allowLocalHttp: true, preprodPurchasesEnabled: true, ...overrides };
  return { config, calls, initial, chain, fetcher, provider: new MasumiProvider(config, { fetch: fetcher, now: () => time }),
    get payment() { return payment; }, get purchase() { return purchase; },
    set losePurchaseResponse(value: boolean) { lostPurchaseResponse = value; },
    set losePaymentResponse(value: boolean) { lostPaymentResponse = value; },
    set hideSeller(value: boolean) { hideSeller = value; }, set hideBuyer(value: boolean) { hideBuyer = value; },
    set walletBalance(value: number) { walletBalance = value; } };
}

test('unconfigured Masumi fails explicitly and never falls back to a local payment', async () => {
  const provider = createPaymentProvider({ PAYMENT_PROVIDER: 'masumi' });
  assert.equal(provider.name, 'masumi');
  await assert.rejects(provider.start(request()), { code: 'MASUMI_NOT_CONFIGURED' });
  assert.equal(paymentProviderStatus({ PAYMENT_PROVIDER: 'masumi' }).configured, false);
});

test('odd-length purchaser identifiers are rejected before contacting the pinned payment node', async () => {
  const s = server();
  await assert.rejects(s.provider.prepareJob({ ...request(), identifier_from_purchaser: '0123456789abcde' }), { code: 'PAYMENT_INVALID_IDENTIFIER' });
  assert.equal(s.calls.length, 0);
});

test('no config status exposes tokens or credentials and mainnet fails closed', () => {
  const env = { PAYMENT_PROVIDER: 'masumi', MASUMI_NETWORK: 'Mainnet', MASUMI_PAYMENT_API_KEY: 'very-secret' };
  assert.throws(() => createPaymentProvider(env), { code: 'MASUMI_INVALID_CONFIG' });
  assert.ok(!JSON.stringify(paymentProviderStatus(env)).includes('very-secret'));
});

test('fixed SKU mapping is exact and unsupported negotiated prices cannot masquerade as a registered price', () => {
  assert.equal(PAYMENT_SKUS.find((entry) => entry.sku === 'full-main-10pct')?.asset_quantity, '22248000');
  assert.equal(selectPaymentSku({ payment_mode: 'deposit', amount_minor: 50000, max_network_fee: '1000' }).mapping_version, 'demo-map-v1');
  assert.equal(selectPaymentSku({ payment_mode: 'deposit', amount_minor: 50000, max_network_fee: '1000' }).asset, 'lovelace');
  assert.throws(() => selectPaymentSku({ payment_mode: 'full', amount_minor: 222479, max_network_fee: '1000' }), { code: 'PAYMENT_UNSUPPORTED_SKU' });
  assert.throws(() => selectPaymentSku({ payment_mode: 'deposit', amount_minor: 50000, max_network_fee: '1.2' }), { code: 'PAYMENT_INVALID_QUANTITY' });
});

test('local demo transaction hashes cannot be confused with blockchain evidence and state survives provider recreation', async () => {
  const req = request('local_demo');
  const provider = new LocalDemoProvider({ scenario: 'delayed', now: () => time });
  const started = await provider.start(req);
  assert.equal(started.state, 'purchase_requested');
  assert.match(started.transaction_hash!, /^demo:/);
  const first = await provider.observe(req, started);
  const second = await new LocalDemoProvider({ scenario: 'delayed' }).observe(req, first);
  assert.equal(second.state, 'escrow_funded');
  const delivered = await provider.submitResult(req, second, resultHash);
  assert.equal(delivered.state, 'result_submitted');
  assert.equal((await provider.observe(req, delivered)).state, 'seller_paid');
  await assert.rejects(provider.requestRefund(req, await provider.observe(req, delivered)), { code: 'PAYMENT_REFUND_UNAVAILABLE' });
});

test('local failures, refunds and mandate limits are enforced', async () => {
  const req = request('local_demo');
  assert.equal((await new LocalDemoProvider({ scenario: 'failed' }).start(req)).state, 'failed');
  const provider = new LocalDemoProvider(); const funded = await provider.start(req);
  const refund = await provider.requestRefund(req, funded);
  assert.equal(refund.state, 'refund_requested'); assert.equal((await provider.observe(req, refund)).state, 'refunded');
  req.authorization.max_deposit_minor = 49999;
  await assert.rejects(provider.start(req), { code: 'PAYMENT_AUTHORIZATION_MISMATCH' });
});

test('Masumi calls exact pinned endpoints with token header, fixed pricing and millisecond purchase deadlines', async () => {
  const s = server(); const started = await s.provider.start(request());
  assert.equal(started.state, 'purchase_requested');
  const create = s.calls.find((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST')!;
  const buy = s.calls.find((call) => call.url.endsWith('/purchase/'))!;
  assert.equal(new Headers(create.init?.headers).get('token'), 'seller-secret');
  assert.equal(new Headers(buy.init?.headers).get('token'), 'buyer-secret');
  assert.equal(new Headers(buy.init?.headers).get('x-api-key'), null);
  assert.equal(create.body?.RequestedFunds, undefined); assert.equal(buy.body?.Amounts, undefined);
  assert.equal(create.body?.payByTime, '2026-10-08T08:20:00.000Z');
  assert.equal(buy.body?.payByTime, String(time.getTime() + 20 * 60000));
  assert.equal(buy.body?.identifierFromPurchaser, request().identifier_from_purchaser);
  for (const [field, minutes] of [['payByTime', 20], ['submitResultTime', 60], ['unlockTime', 90], ['externalDisputeUnlockTime', 120]] as const) {
    assert.equal(create.body?.[field], new Date(time.getTime() + minutes * 60000).toISOString());
    assert.equal(buy.body?.[field], String(time.getTime() + minutes * 60000));
  }
});

test('Preprod smoke profile creates shorter ISO deadlines and forwards the seller milliseconds unchanged', async () => {
  const s = server(request(), { deadlineProfile: 'preprod_smoke' });
  const deadlines = { payByTime: 5, submitResultTime: 16, unlockTime: 32, externalDisputeUnlockTime: 48 };
  for (const [field, minutes] of Object.entries(deadlines)) {
    s.initial.payment[field] = String(time.getTime() + minutes * 60000);
    s.initial.purchase[field] = s.initial.payment[field];
  }
  await s.provider.start(request());
  const create = s.calls.find(call => call.url.endsWith('/payment/') && call.init?.method === 'POST')!;
  const buy = s.calls.find(call => call.url.endsWith('/purchase/'))!;
  for (const [field, minutes] of Object.entries(deadlines)) {
    assert.equal(create.body?.[field], new Date(time.getTime() + minutes * 60000).toISOString());
    assert.equal(buy.body?.[field], String(time.getTime() + minutes * 60000));
  }
  const job = await s.provider.prepareJob(request());
  for (const [field, minutes] of Object.entries(deadlines)) {
    assert.equal(job[field as keyof typeof deadlines], time.getTime() / 1000 + minutes * 60);
  }
  assert.equal(create.body?.agentIdentifier, agent);
  assert.equal(buy.body?.agentIdentifier, agent);
});

test('smoke profile does not rewrite original seller deadlines when preparing a buyer purchase', async () => {
  const s = server(request(), { deadlineProfile: 'preprod_smoke' });
  await s.provider.start(request());
  const buy = s.calls.find(call => call.url.endsWith('/purchase/'))!;
  for (const field of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime']) {
    assert.equal(buy.body?.[field], s.initial.payment[field]);
  }
});

test('server timing profile configuration defaults to standard, exposes the selected profile and rejects unknown values', () => {
  const env = { PAYMENT_PROVIDER: 'masumi', MASUMI_PAYMENT_SERVICE_URL: 'https://seller.example/api/v1',
    MASUMI_PAYMENT_API_KEY: 'seller-token', MASUMI_BUYER_API_KEY: 'buyer-token', MASUMI_SELLER_VKEY: seller,
    MASUMI_SKUS: JSON.stringify({ 'deposit-500': agent }) };
  assert.equal(readMasumiConfig(env)?.deadlineProfile, 'standard');
  assert.equal(paymentProviderStatus(env).timing_profile, 'standard');
  const smoke = { ...env, MASUMI_TIMING_PROFILE: 'preprod_smoke' };
  assert.equal(readMasumiConfig(smoke)?.deadlineProfile, 'preprod_smoke');
  assert.equal(paymentProviderStatus(smoke).timing_profile, 'preprod_smoke');
  for (const profile of ['fast', 'PREPROD_SMOKE', '']) {
    assert.throws(() => readMasumiConfig({ ...env, MASUMI_TIMING_PROFILE: profile }), { code: 'MASUMI_INVALID_CONFIG' });
    assert.throws(() => readMasumiConfig({ MASUMI_TIMING_PROFILE: profile }), { code: 'MASUMI_INVALID_CONFIG' });
    assert.equal(paymentProviderStatus({ ...env, MASUMI_TIMING_PROFILE: profile }).reason, 'MASUMI_INVALID_CONFIG');
  }
  assert.throws(() => readMasumiConfig({ ...smoke, MASUMI_NETWORK: 'Mainnet' }), { code: 'MASUMI_INVALID_CONFIG' });
});

test('repeat starts recover the same intent and never initiate a second buyer payment', async () => {
  const s = server(); const one = await s.provider.start(request()); const two = await s.provider.start(request());
  assert.equal(one.blockchain_identifier, two.blockchain_identifier);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
});

test('lost buyer response is uncertain, then resolved by the stable identifier without another purchase', async () => {
  const s = server(); s.losePurchaseResponse = true;
  const uncertain = await s.provider.start(request());
  assert.equal(uncertain.state, 'reconciliation_required'); assert.ok(uncertain.blockchain_identifier);
  assert.equal(uncertain.provider_payment_id, undefined);
  assert.equal(uncertain.seller_payment_id, 'provider-payment-1');
  const resolved = await s.provider.observe(request(), uncertain);
  assert.equal(resolved.state, 'purchase_requested');
  assert.equal(resolved.provider_payment_id, 'provider-purchase-1');
  await s.provider.start(request());
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
  assert.ok(!JSON.stringify(uncertain).includes('secret-token'));
});

test('lost seller response is found by persisted intent metadata; observe never creates or charges', async () => {
  const s = server(); s.losePaymentResponse = true;
  const unknown = await s.provider.start(request());
  assert.equal(unknown.state, 'reconciliation_required'); assert.equal(unknown.blockchain_identifier, undefined);
  assert.equal(unknown.provider_payment_id, undefined); assert.equal(unknown.seller_payment_id, undefined);
  const recovered = await s.provider.observe(request(), unknown);
  assert.equal(recovered.blockchain_identifier, 'signed-blockchain-identifier');
  assert.equal(recovered.state, 'reconciliation_required');
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 0);
  await s.provider.start(request());
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
});

test('concurrent start calls are coalesced and wrong observation identities cannot cross orders', async () => {
  const s = server(); const [one, two] = await Promise.all([s.provider.start(request()), s.provider.start(request())]);
  assert.equal(one.provider_payment_id, two.provider_payment_id);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
  await assert.rejects(s.provider.observe(request(), { ...one, input_hash: 'd'.repeat(64) }), { code: 'PAYMENT_IDENTITY_MISMATCH' });
});

test('coalescing never accepts a changed input under the same concurrent intent id', async () => {
  const s = server(); const starting = s.provider.start(request());
  const changed = request(); changed.input_hash = 'c'.repeat(64);
  await assert.rejects(s.provider.start(changed), { code: 'PAYMENT_IDENTITY_MISMATCH' });
  await starting;
});

test('seconds-shaped deadlines are rejected before issuing a purchase', async () => {
  const s = server(); s.initial.payment.payByTime = String(Math.floor(time.getTime() / 1000));
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_INVALID_RESPONSE' });
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 0);
});

test('submit-result cannot change an already delivered voucher hash', async () => {
  const s = server(); const pending = await s.provider.start(request()); assert.ok(s.purchase); funded(s.purchase);
  const fund = await s.provider.observe(request(), pending);
  const delivered = await s.provider.submitResult(request(), fund, resultHash);
  await assert.rejects(s.provider.submitResult(request(), delivered, 'e'.repeat(64)), { code: 'PAYMENT_RESULT_MISMATCH' });
});

test('funding, result submission and actual net seller payout remain different states', async () => {
  const s = server(request(), { blockfrostProjectId: 'preprodPrivateTestKey' }); const pending = await s.provider.start(request());
  assert.ok(s.purchase); funded(s.purchase);
  const fund = await s.provider.observe(request(), pending); assert.equal(fund.state, 'escrow_funded');
  const delivered = await s.provider.submitResult(request(), fund, resultHash); assert.equal(delivered.state, 'result_submitted');
  funded(s.purchase, 'Withdrawn'); s.purchase.CurrentTransaction = { status: 'Confirmed', txHash: withdrawalHash };
  s.purchase.TransactionHistory = [{ status: 'Confirmed', txHash: 'b'.repeat(64) }];
  assert.deepEqual(s.purchase.WithdrawnForSeller, []);
  const paid = await s.provider.observe(request(), delivered);
  assert.equal(paid.state, 'seller_paid'); assert.equal(paid.transaction_hash, withdrawalHash);
  const proof = (paid.raw as RecordData).settlement as RecordData;
  assert.equal(proof.escrow_transaction_hash, 'b'.repeat(64)); assert.equal(proof.escrow_output_index, 0);
  assert.equal(proof.seller_gross_lovelace, '3564770'); assert.equal(proof.seller_net_lovelace, '3067271');
  assert.equal(proof.chain_fee_lovelace, '497499'); assert.equal(proof.protocol_fee_lovelace, '1435230');
  assert.ok(!JSON.stringify(paid).includes('preprodPrivateTestKey'));
  const restarted = new MasumiProvider(s.config, { fetch: s.fetcher, now: () => time });
  const reread = await restarted.observe(request(), JSON.parse(JSON.stringify(paid)));
  assert.equal(reread.state, 'seller_paid'); assert.deepEqual((reread.raw as RecordData).settlement, proof);
  const reads = s.calls.filter(call => new URL(call.url).hostname === 'cardano-preprod.blockfrost.io');
  assert.equal(reads.length, 8);
  assert.ok(reads.every(call => new Headers(call.init?.headers).get('project_id') === 'preprodPrivateTestKey'
    && new Headers(call.init?.headers).get('token') === null && call.init?.redirect === 'error'));
});

async function withdrawnFixture() {
  const s = server(request(), { blockfrostProjectId: 'preprodPrivateTestKey', collectionAddress: 'addr_test1seller' });
  const pending = await s.provider.start(request()); assert.ok(s.purchase);
  funded(s.purchase);
  const delivered = await s.provider.submitResult(request(), await s.provider.observe(request(), pending), resultHash);
  funded(s.purchase, 'Withdrawn'); s.purchase.CurrentTransaction = { status: 'Confirmed', txHash: withdrawalHash };
  s.purchase.TransactionHistory = [{ status: 'Confirmed', txHash: 'b'.repeat(64) }];
  return { s, delivered };
}

for (const mismatch of ['transaction', 'escrow-transaction', 'destination', 'asset', 'collateral', 'reference', 'datum',
  'result', 'nonce', 'seller', 'contract', 'fee-reference', 'net', 'invalid-contract', 'change-only'] as const) {
  test(`ordinary Withdrawn rejects ${mismatch} mismatch despite an empty provider payout array`, async () => {
    const { s, delivered } = await withdrawnFixture();
    if (mismatch === 'transaction') s.chain.tx.hash = 'a'.repeat(64);
    if (mismatch === 'escrow-transaction') s.chain.utxos.inputs[0].tx_hash = 'a'.repeat(64);
    if (mismatch === 'destination') s.chain.utxos.outputs[0].address = 'addr_test1different';
    if (mismatch === 'asset') s.chain.utxos.outputs[0].amount[0].unit = 'unexpected-token';
    if (mismatch === 'collateral') s.chain.utxos.inputs[0].collateral = true;
    if (mismatch === 'reference') s.chain.utxos.inputs[0].reference = true;
    if (mismatch === 'datum') s.chain.datum.json_value.fields[7] = { bytes: 'a'.repeat(64) };
    if (mismatch === 'result') s.chain.datum.json_value.fields[8] = { bytes: 'a'.repeat(64) };
    if (mismatch === 'nonce') s.chain.datum.json_value.fields[5] = { bytes: 'a'.repeat(20) };
    if (mismatch === 'seller') s.chain.datum.json_value.fields[1] = { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: 'a'.repeat(56) }] }] };
    if (mismatch === 'contract') s.chain.utxos.inputs[0].address = 'addr_test1othercontract';
    if (mismatch === 'fee-reference') s.chain.feeDatum.json_value.fields[0] = { bytes: 'a'.repeat(64) };
    if (mismatch === 'net') s.chain.utxos.outputs[2].amount[0].quantity = '23734128';
    if (mismatch === 'invalid-contract') s.chain.tx.valid_contract = false;
    if (mismatch === 'change-only') s.chain.utxos.outputs.splice(0, 1);
    await assert.rejects(s.provider.observe(request(), delivered), { code: 'MASUMI_PAYOUT_UNVERIFIED' });
    assert.equal(s.calls.filter(call => call.url.endsWith('/purchase/')).length, 1);
  });
}

test('rolled-back withdrawal remains reconciliation and cannot reuse an older confirmed transaction as payout', async () => {
  const { s, delivered } = await withdrawnFixture(); assert.ok(s.purchase);
  s.purchase.CurrentTransaction = { status: 'RolledBack', txHash: withdrawalHash };
  const reconciled = await s.provider.observe(request(), delivered);
  assert.equal(reconciled.state, 'reconciliation_required');
  assert.equal(s.calls.filter(call => new URL(call.url).hostname === 'cardano-preprod.blockfrost.io').length, 0);
  s.purchase.CurrentTransaction = { status: 'Confirmed', txHash: withdrawalHash };
  assert.equal((await s.provider.observe(request(), JSON.parse(JSON.stringify(reconciled)))).state, 'seller_paid');
});

test('settlement fails closed without the read key or prior result anchor even when provider payout amounts exist', async () => {
  const noKey = server(); const pending = await noKey.provider.start(request()); assert.ok(noKey.purchase);
  funded(noKey.purchase, 'Withdrawn'); noKey.purchase.WithdrawnForSeller = [{ unit: '', amount: '4750000' }];
  await assert.rejects(noKey.provider.observe(request(), pending), { code: 'MASUMI_PAYOUT_UNVERIFIED' });
  const { s } = await withdrawnFixture();
  await assert.rejects(s.provider.observe(request()), { code: 'MASUMI_PAYOUT_UNVERIFIED' });
});

test('transient settlement reads are redacted and retry only observation without another purchase', async () => {
  const { s, delivered } = await withdrawnFixture(); s.chain.fail = true;
  await assert.rejects(s.provider.observe(request(), delivered), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'MASUMI_SETTLEMENT_UNAVAILABLE');
    assert.ok(!error.message.includes('preprodPrivateTestKey')); return true;
  });
  s.chain.fail = false;
  assert.equal((await s.provider.observe(request(), delivered)).state, 'seller_paid');
  assert.equal(s.calls.filter(call => call.url.endsWith('/purchase/')).length, 1);
});

for (const missing of ['seller', 'buyer'] as const) {
  test(`a temporarily missing ${missing} record preserves original result lineage across restart`, async () => {
    const { s, delivered } = await withdrawnFixture();
    delete (delivered.raw as RecordData).result_transaction_hash;
    if (missing === 'seller') s.hideSeller = true; else s.hideBuyer = true;
    let uncertain = delivered;
    if (missing === 'buyer') {
      await assert.rejects(s.provider.observe(request(), delivered), { code: 'PAYMENT_IDENTITY_MISMATCH' });
    } else {
      uncertain = await s.provider.observe(request(), delivered);
      assert.equal(uncertain.state, 'reconciliation_required');
      assert.equal((uncertain.raw as RecordData).result_transaction_hash, 'b'.repeat(64));
    }
    s.hideSeller = false; s.hideBuyer = false;
    const restarted = new MasumiProvider(s.config, { fetch: s.fetcher, now: () => time });
    const paid = await restarted.observe(request(), JSON.parse(JSON.stringify(uncertain)));
    assert.equal(paid.state, 'seller_paid');
    assert.equal(s.calls.filter(call => call.url.endsWith('/purchase/')).length, 1);
  });
}

test('already withdrawn start without persisted result evidence fails closed and direct settlement config rejects invalid values', async () => {
  const { s } = await withdrawnFixture();
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_PAYOUT_UNVERIFIED' });
  assert.equal(s.calls.filter(call => call.url.endsWith('/purchase/')).length, 1);
  assert.throws(() => new MasumiProvider({ ...s.config, blockfrostProjectId: 'mainnetInvalid' }), { code: 'MASUMI_INVALID_CONFIG' });
  assert.throws(() => new MasumiProvider({ ...s.config, collectionAddress: 'addr1mainnet' }), { code: 'MASUMI_INVALID_CONFIG' });
});

test('buyer refund request does not call seller authorization and requires observed refund withdrawal', async () => {
  const s = server(); const pending = await s.provider.start(request()); assert.ok(s.purchase); funded(s.purchase);
  const fundedObservation = await s.provider.observe(request(), pending);
  const refund = await s.provider.requestRefund(request(), fundedObservation); assert.equal(refund.state, 'refund_requested');
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/authorize-refund')).length, 0);
  funded(s.purchase, 'RefundWithdrawn'); s.purchase.WithdrawnForBuyer = [{ unit: '', amount: '5000000' }];
  assert.equal((await s.provider.observe(request(), refund)).state, 'refunded');
});

for (const mismatch of ['network', 'input', 'asset', 'quantity', 'seller'] as const) {
  test(`rejects ${mismatch} mismatch in chain observation`, async () => {
    const s = server(); const pending = await s.provider.start(request()); assert.ok(s.purchase); funded(s.purchase);
    if (mismatch === 'network') s.purchase.PaymentSource = { network: 'Mainnet', policyId: agent.slice(0, 56), paymentType: 'Web3CardanoV1' };
    if (mismatch === 'input') s.purchase.inputHash = 'c'.repeat(64);
    if (mismatch === 'asset') s.purchase.PaidFunds = [{ unit: 'unexpected-token', amount: '5000000' }];
    if (mismatch === 'quantity') s.purchase.PaidFunds = [{ unit: '', amount: '5000001' }];
    if (mismatch === 'seller') s.purchase.SellerWallet = { walletVkey: 'wrong-seller' };
    await assert.rejects(s.provider.observe(request(), pending), { code: 'PAYMENT_IDENTITY_MISMATCH' });
  });
}

test('unknown chain states, absent confirmation and rollback never create a paid order', async () => {
  const s = server(); const pending = await s.provider.start(request()); assert.ok(s.purchase); funded(s.purchase);
  s.purchase.onChainState = 'Completed';
  await assert.rejects(s.provider.observe(request(), pending), { code: 'MASUMI_INVALID_RESPONSE' });
  s.purchase.onChainState = 'FundsLocked'; s.purchase.CurrentTransaction = null;
  assert.equal((await s.provider.observe(request(), pending)).state, 'reconciliation_required');
  s.purchase.CurrentTransaction = { status: 'RolledBack', txHash: 'b'.repeat(64) };
  assert.equal((await s.provider.observe(request(), pending)).state, 'reconciliation_required');
});

test('fee ceiling fails closed unless actual isolated wallet selection and available quantity prove the bound', async () => {
  const s = server(); s.walletBalance = 6000001;
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_FEE_CAP_NOT_ENFORCED' });
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 0);
  s.walletBalance = 4999999;
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_INSUFFICIENT_FUNDS' });
  const notDedicated = server(request(), { dedicatedBuyerWallet: false });
  await assert.rejects(notDedicated.provider.start(request()), { code: 'MASUMI_FEE_CAP_NOT_ENFORCED' });
  const noLifecycleProof = server(request(), { buyerLifecycleIsolated: false });
  await assert.rejects(noLifecycleProof.provider.start(request()), { code: 'MASUMI_FEE_CAP_NOT_ENFORCED' });
  assert.equal(noLifecycleProof.calls.filter((call) => call.url.endsWith('/purchase/')).length, 0);
});

test('proof snapshots remove unknown fields, wallet secrets and RPC credentials', async () => {
  const s = server(); const pending = await s.provider.start(request()); assert.ok(s.payment && s.purchase); funded(s.purchase);
  s.payment.SmartContractWallet = { walletVkey: seller, mnemonic: 'do-not-leak' };
  s.purchase.PaymentSource = { network: 'Preprod', policyId: agent.slice(0, 56), paymentType: 'Web3CardanoV1', rpcProviderApiKey: 'do-not-leak' };
  const snapshot = await s.provider.observe(request(), pending);
  assert.ok(!JSON.stringify(snapshot).includes('do-not-leak'));
});

test('real legacy checkout normalizes lovelace and reconciles buyer timeout into one booking without changing provider id', async () => {
  const store = new LegacyStore(':memory:', { now: () => time });
  try {
    const quote = store.createQuote({ customer_id: 'customer-001', slot_id: 'slot-main', discount_bps: 0,
      requires_owner_approval: false, service_spec: { service_id: 'tyre_change', vehicle_type: 'personal',
        wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 } });
    const order = store.createOrder(quote.id);
    const sku = selectPaymentSku({ payment_mode: 'deposit', amount_minor: 50000, max_network_fee: '1000000',
      network: 'Preprod', seller_id: seller });
    const input = { provider: 'masumi' as const, sku: sku.sku, asset_quantity: sku.asset_quantity,
      max_network_fee: sku.max_network_fee, seller_id: seller,
      authorization: { kind: 'human_checkout' as const, actor_id: 'human-customer-1', customer_id: order.customer_id,
        quote_id: quote.id, quote_version: quote.version, payment_mode: 'deposit' as const,
        max_total_minor: quote.price.total_minor, max_deposit_minor: 50000, network: 'Preprod' as const,
        seller_id: seller, asset: sku.asset, asset_quantity: sku.asset_quantity, max_network_fee: sku.max_network_fee,
        mapping_version: sku.mapping_version, approved_at: time.toISOString() } };
    const intent = store.prepareCheckout(order.id, input);
    assert.equal(intent.asset, 'lovelace');
    assert.match(intent.identifier_from_purchaser, /^[a-f0-9]{14,26}$/);
    store.markPurchaseRequested(intent.intent_id);
    const s = server(intent); s.losePurchaseResponse = true;
    const unknown = await s.provider.start(intent);
    assert.equal(unknown.provider_payment_id, undefined);
    assert.equal(unknown.seller_payment_id, 'provider-payment-1');
    store.recordPaymentObservation(intent.intent_id, unknown);
    assert.equal(store.calendar().filter((entry) => entry.order_id === order.id).length, 0);
    assert.ok(s.purchase); funded(s.purchase);
    const updated = await s.provider.observe(intent, store.getPaymentIntent(intent.intent_id).observation);
    assert.equal(updated.provider_payment_id, 'provider-purchase-1');
    assert.equal(updated.asset, 'lovelace');
    store.recordPaymentObservation(intent.intent_id, updated);
    store.recordPaymentObservation(intent.intent_id, await s.provider.observe(intent, updated));
    assert.equal(store.getOrder(order.id).status, 'confirmed');
    assert.equal(store.calendar().filter((entry) => entry.order_id === order.id).length, 1);
    assert.equal(store.getPaymentIntent(intent.intent_id).observation?.provider_payment_id, 'provider-purchase-1');
    assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
  } finally { store.close(); }
});

test('reconciliation rejects changing an already known buyer purchase id', async () => {
  const s = server(); const started = await s.provider.start(request()); assert.ok(s.purchase);
  s.purchase.id = 'replacement-buyer-id';
  await assert.rejects(s.provider.observe(request(), started), { code: 'PAYMENT_IDENTITY_MISMATCH' });
});

test('HTTPS is required for remote services and HTTP requires explicit opt-in plus loopback', () => {
  const env = { PAYMENT_PROVIDER: 'masumi', MASUMI_PAYMENT_SERVICE_URL: 'https://seller.example/api/v1',
    MASUMI_BUYER_SERVICE_URL: 'https://buyer.example/api/v1', MASUMI_PAYMENT_API_KEY: 'seller-token',
    MASUMI_BUYER_API_KEY: 'buyer-token', MASUMI_SELLER_VKEY: seller, MASUMI_SKUS: JSON.stringify({ 'deposit-500': agent }) };
  assert.ok(readMasumiConfig(env));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const local = { ...env, MASUMI_PAYMENT_SERVICE_URL: `http://${host}:3001/api/v1` };
    assert.throws(() => readMasumiConfig(local), { code: 'MASUMI_INVALID_CONFIG' });
    assert.ok(readMasumiConfig({ ...local, MASUMI_ALLOW_LOCAL_HTTP: 'true' }));
  }
  for (const unsafe of ['http://seller.example/api/v1', 'http://localhost.example/api/v1',
    'http://127.0.0.1.evil.example/api/v1', 'https://user:password@seller.example/api/v1',
    'https://seller.example/api/v1?credential=secret', 'https://seller.example/api/v1#fragment']) {
    assert.throws(() => readMasumiConfig({ ...env, MASUMI_PAYMENT_SERVICE_URL: unsafe, MASUMI_ALLOW_LOCAL_HTTP: 'true' }), { code: 'MASUMI_INVALID_CONFIG' });
  }
  assert.throws(() => readMasumiConfig({ ...env, MASUMI_BUYER_SERVICE_URL: 'http://remote-buyer.example/api/v1',
    MASUMI_ALLOW_LOCAL_HTTP: 'true' }), { code: 'MASUMI_INVALID_CONFIG' });
});

test('lifecycle declaration is required and metadata never claims that a config flag proves live enforcement', () => {
  const env = { PAYMENT_PROVIDER: 'masumi', MASUMI_PAYMENT_SERVICE_URL: 'https://seller.example/api/v1',
    MASUMI_PAYMENT_API_KEY: 'seller-token', MASUMI_BUYER_API_KEY: 'buyer-token', MASUMI_SELLER_VKEY: seller,
    MASUMI_SKUS: JSON.stringify({ 'deposit-500': agent }), MASUMI_DEDICATED_BUYER_WALLET: 'true', MASUMI_BUYER_WALLET_ADDRESS: 'addr_test_buyer' };
  const missing = paymentProviderStatus(env);
  assert.equal(missing.reason, 'MASUMI_FEE_CAP_NOT_ENFORCED');
  const declared = paymentProviderStatus({ ...env, MASUMI_BUYER_LIFECYCLE_ISOLATED: 'true' });
  assert.equal(declared.live_verification, 'NOT_RUN');
  assert.equal(declared.reason, 'MASUMI_PREPROD_PURCHASES_DISABLED');
  assert.equal(declared.purchase_ready, false);
  assert.equal(declared.purchase_configuration_complete, true);
  assert.equal(declared.external_lifecycle_proof, 'GP_NOT_RUN_operator_controls_required');
  const enabled = paymentProviderStatus({ ...env, MASUMI_BUYER_LIFECYCLE_ISOLATED: 'true', MASUMI_ENABLE_PREPROD_PURCHASES: 'true' });
  assert.equal(enabled.purchase_ready, true);
  assert.equal(enabled.reason, 'LIVE_SMOKE_TEST_REQUIRED');
  assert.equal(enabled.live_verification, 'NOT_RUN');
  assert.equal(enabled.readiness_definition, 'operator_preprod_test_enabled_not_verified');
});

test('Preprod purchases require explicit operator opt-in even with complete wallet configuration', async () => {
  const s = server(request(), { preprodPurchasesEnabled: false });
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_PREPROD_PURCHASES_DISABLED' });
  assert.equal(s.calls.length, 0);
});

test('one provider serializes distinct intents for the complete buyer wallet lifecycle', async () => {
  const s = server(); const pending = await s.provider.start(request());
  const other = { ...request(), intent_id: 'different-intent' };
  await assert.rejects(s.provider.start(other), { code: 'MASUMI_BUYER_WALLET_BUSY' });
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
  assert.ok(s.purchase); funded(s.purchase, 'ResultSubmitted');
  await s.provider.observe(request(), pending);
  await assert.rejects(s.provider.start(other), { code: 'MASUMI_BUYER_WALLET_BUSY' });
});

test('owner resume completes the first buyer purchase after seller creation and failed wallet preflight', async () => {
  const s = server(); s.walletBalance = 6000001;
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_FEE_CAP_NOT_ENFORCED' });
  const pending = await s.provider.observe(request());
  assert.equal(pending.provider_payment_id, undefined); assert.equal(pending.seller_payment_id, 'provider-payment-1');
  s.walletBalance = 6000000;
  const resumed = await s.provider.resumePurchase(request(), pending);
  assert.equal(resumed.provider_payment_id, 'provider-purchase-1');
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
  await s.provider.resumePurchase(request(), resumed);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
});

test('owner resume after buyer timeout resolves existing purchase without charging again', async () => {
  const s = server(); s.losePurchaseResponse = true;
  const unknown = await s.provider.start(request());
  const resumed = await s.provider.resumePurchase(request(), unknown);
  assert.equal(resumed.provider_payment_id, 'provider-purchase-1');
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
});

test('owner resume refuses absent seller payment, expired deadline and mismatched evidence', async () => {
  const s = server(); const empty = { provider: 'masumi' as const, network: 'Preprod' as const,
    state: 'reconciliation_required' as const, asset: 'lovelace', asset_quantity: '5000000', seller_id: seller,
    input_hash: request().input_hash, observed_at: time.toISOString() };
  await assert.rejects(s.provider.resumePurchase(request(), empty), { code: 'MASUMI_RESUME_UNSAFE' });
  assert.equal(s.calls.filter((call) => call.init?.method === 'POST' && call.url.endsWith('/payment/')).length, 0);
  s.walletBalance = 6000001;
  await assert.rejects(s.provider.start(request()), { code: 'MASUMI_FEE_CAP_NOT_ENFORCED' });
  const pending = await s.provider.observe(request()); assert.ok(s.payment);
  s.payment.payByTime = String(time.getTime() - 1);
  await assert.rejects(s.provider.resumePurchase(request(), pending), { code: 'MASUMI_RESUME_EXPIRED' });
  await assert.rejects(s.provider.resumePurchase(request(), { ...pending, input_hash: 'c'.repeat(64) }), { code: 'PAYMENT_IDENTITY_MISMATCH' });
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 0);
});

test('seller refund authorization is separate from buyer request and uses seller credentials', async () => {
  const s = server(); const pending = await s.provider.start(request()); assert.ok(s.purchase); funded(s.purchase);
  const current = await s.provider.observe(request(), pending);
  await assert.rejects(s.provider.authorizeRefund(request(), current), { code: 'PAYMENT_REFUND_UNAVAILABLE' });
  const requested = await s.provider.requestRefund(request(), current);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/authorize-refund')).length, 0);
  const authorized = await s.provider.authorizeRefund(request(), requested);
  assert.equal(authorized.state, 'refunded');
  const call = s.calls.find((entry) => entry.url.endsWith('/payment/authorize-refund'))!;
  assert.equal(new Headers(call.init?.headers).get('token'), 'seller-secret');
  assert.deepEqual(call.body, { network: 'Preprod', blockchainIdentifier: pending.blockchain_identifier });
  await s.provider.authorizeRefund(request(), authorized);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/authorize-refund')).length, 1);
});

test('MIP-003 prepareJob only prepares the seller and returns seconds without spending buyer funds', async () => {
  const s = server(request(), { preprodPurchasesEnabled: false });
  const job = await s.provider.prepareJob(request());
  assert.deepEqual(job, { id: 'intent-1', blockchainIdentifier: 'signed-blockchain-identifier',
    payByTime: Math.floor(time.getTime() / 1000) + 20 * 60,
    submitResultTime: Math.floor(time.getTime() / 1000) + 60 * 60,
    unlockTime: Math.floor(time.getTime() / 1000) + 90 * 60,
    externalDisputeUnlockTime: Math.floor(time.getTime() / 1000) + 120 * 60,
    agentIdentifier: agent, sellerVKey: seller, identifierFromPurchaser: request().identifier_from_purchaser,
    input_hash: request().input_hash });
  assert.equal(s.calls.filter((call) => new URL(call.url).port === '3002').length, 0);
  const second = await s.provider.prepareJob(request()); assert.deepEqual(second, job);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
});

test('concurrent seller preparations coalesce and start reuses the prepared seller identifier', async () => {
  const s = server(); const [one, two] = await Promise.all([s.provider.prepareJob(request()), s.provider.prepareJob(request())]);
  assert.equal(one.blockchainIdentifier, two.blockchainIdentifier);
  const paid = await s.provider.start(request()); assert.equal(paid.blockchain_identifier, one.blockchainIdentifier);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
  assert.equal(s.calls.filter((call) => call.url.endsWith('/purchase/')).length, 1);
});

test('seller preparation timeout rejects rather than fabricating an id and recovered preparation reuses the intent', async () => {
  const s = server(); s.losePaymentResponse = true;
  await assert.rejects(s.provider.prepareJob(request()), { code: 'MASUMI_TRANSPORT_UNCERTAIN' });
  const recovered = await s.provider.prepareJob(request());
  assert.equal(recovered.blockchainIdentifier, 'signed-blockchain-identifier');
  assert.equal(s.calls.filter((call) => call.url.endsWith('/payment/') && call.init?.method === 'POST').length, 1);
  assert.equal(s.calls.filter((call) => new URL(call.url).port === '3002').length, 0);
});

test('MIP-003 seconds conversion validates source milliseconds and input identity', async () => {
  const seconds = server(); seconds.initial.payment.payByTime = String(Math.floor(time.getTime() / 1000));
  await assert.rejects(seconds.provider.prepareJob(request()), { code: 'MASUMI_INVALID_RESPONSE' });
  const mismatch = server(); mismatch.initial.payment.inputHash = 'd'.repeat(64);
  await assert.rejects(mismatch.provider.prepareJob(request()), { code: 'PAYMENT_IDENTITY_MISMATCH' });
});

test('local job preparation is explicitly synthetic and deterministic', async () => {
  const provider = new LocalDemoProvider({ now: () => time });
  const job = await provider.prepareJob(request('local_demo'));
  assert.equal(job.simulation, true); assert.equal(job.provider, 'local_demo');
  assert.match(job.blockchainIdentifier, /^demo:/); assert.match(job.agentIdentifier, /^demo:/);
  assert.deepEqual(await provider.prepareJob(request('local_demo')), job);
});

test('chat consent is rejected by the external payment boundary even with otherwise valid Preprod data', () => {
  const attempted = request('masumi'); attempted.authorization.kind = 'demo_chat';
  assert.throws(() => validateRequest(attempted, 'masumi', seller), /cannot authorize an external payment/);
  const local = request('local_demo'); local.authorization.kind = 'demo_chat';
  assert.doesNotThrow(() => validateRequest(local, 'local_demo', 'pneu007-demo'));
});
