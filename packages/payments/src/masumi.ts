import { BusinessError, type PaymentJob, type PaymentObservation, type PaymentProvider, type PaymentRequest } from '../../contracts/index.js';
import { integer, object, string, validateRequest, type JsonObject } from './common.js';

export const MASUMI_VERSION = '5fccf58b0f30873085b59ee540c67b4ae8433cd0';
export interface MasumiConfig {
  sellerUrl: string; buyerUrl: string; sellerToken: string; buyerToken: string;
  sellerVkey: string; skus: Record<string, string>; timeoutMs?: number;
  buyerWalletAddress?: string;
  dedicatedBuyerWallet?: boolean;
  buyerLifecycleIsolated?: boolean;
  allowLocalHttp?: boolean;
  preprodPurchasesEnabled?: boolean;
  deadlineProfile?: 'standard' | 'preprod_smoke';
}
export interface MasumiOptions { fetch?: typeof fetch; now?: () => Date }

export function validateMasumiUrl(value: string, allowLocalHttp = false): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BusinessError('MASUMI_INVALID_CONFIG', 'Masumi service URL is invalid', 503); }
  const localHttp = parsed.protocol === 'http:' && allowLocalHttp
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.pathname.replace(/\/$/, '').endsWith('/api/v1')) {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Masumi requires HTTPS; explicitly allowed HTTP must use a loopback host and /api/v1', 503);
  }
  return parsed.toString().replace(/\/$/, '');
}

class HttpError extends Error {
  constructor(readonly status: number) { super(`Masumi returned HTTP ${status}`); }
}
function amounts(value: unknown, label: string): Array<{ unit: string; amount: string }> {
  if (!Array.isArray(value)) throw new BusinessError('MASUMI_INVALID_RESPONSE', `${label} missing`, 502);
  return value.map((entry) => {
    const data = object(entry, label);
    if (typeof data.unit !== 'string') throw new BusinessError('MASUMI_INVALID_RESPONSE', `${label} asset missing`, 502);
    integer(data.amount, label);
    return { unit: data.unit, amount: String(data.amount) };
  });
}
function domainAsset(unit: string): string { return unit === '' ? 'lovelace' : unit; }
function exactAmounts(value: unknown, request: PaymentRequest): void {
  const funds = amounts(value, 'funds');
  if (funds.length !== 1 || domainAsset(funds[0].unit) !== request.asset || funds[0].amount !== request.asset_quantity) {
    throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Masumi asset or quantity differs from approved SKU', 502);
  }
}
function validTimestamp(value: unknown): string {
  const timestamp = string(value, 'deadline');
  const number = integer(timestamp, 'deadline');
  if (number < 1_000_000_000_000n || number > 99_999_999_999_999n) {
    throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Pinned API requires millisecond deadlines, not seconds', 502);
  }
  return timestamp;
}

/** Cardano Preprod only. No local fallback, no custom pricing and no client-side credentials. */
export class MasumiProvider implements PaymentProvider {
  readonly name = 'masumi' as const;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly activeStarts = new Map<string, { fingerprint: string; promise: Promise<PaymentObservation> }>();
  private readonly sellerPreparations = new Map<string, { fingerprint: string; promise: Promise<JsonObject> }>();
  private walletIntent?: string;
  constructor(private readonly config: MasumiConfig | undefined, options: MasumiOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (config) {
      if (config.deadlineProfile !== undefined && config.deadlineProfile !== 'standard' && config.deadlineProfile !== 'preprod_smoke') {
        throw new BusinessError('MASUMI_INVALID_CONFIG', 'Unknown Masumi timing profile', 503);
      }
      this.config = { ...config, sellerUrl: validateMasumiUrl(config.sellerUrl, config.allowLocalHttp),
        buyerUrl: validateMasumiUrl(config.buyerUrl, config.allowLocalHttp) };
    }
  }

  private configured(): MasumiConfig {
    if (!this.config) throw new BusinessError('MASUMI_NOT_CONFIGURED', 'Masumi Preprod node, keys, seller and SKU registrations are required', 503);
    return this.config;
  }

  private validate(request: PaymentRequest): MasumiConfig {
    const config = this.configured();
    validateRequest(request, this.name, config.sellerVkey);
    if (!config.skus[request.sku]) throw new BusinessError('MASUMI_SKU_NOT_REGISTERED', 'This fixed SKU is not registered on Preprod', 503);
    return config;
  }

  private async api(side: 'seller' | 'buyer', path: string, body?: JsonObject): Promise<JsonObject> {
    const config = this.configured();
    let response: Response;
    try {
      response = await this.fetcher(`${side === 'seller' ? config.sellerUrl : config.buyerUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { token: side === 'seller' ? config.sellerToken : config.buyerToken, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10000), redirect: 'error',
      });
    } catch {
      throw new BusinessError('MASUMI_TRANSPORT_UNCERTAIN', 'Masumi response unavailable; reconcile persisted identifier before retry', 503);
    }
    if (!response.ok) throw new HttpError(response.status);
    let data: unknown;
    try { data = await response.json(); } catch { throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Masumi response is not JSON', 502); }
    const envelope = object(data);
    if (envelope.status !== 'success') throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Masumi success envelope missing', 502);
    return object(envelope.data, 'data');
  }

  private async resolve(side: 'seller' | 'buyer', identifier: string): Promise<JsonObject | undefined> {
    try {
      return await this.api(side, `/${side === 'seller' ? 'payment' : 'purchase'}/resolve-blockchain-identifier`, {
        blockchainIdentifier: identifier, network: 'Preprod', includeHistory: 'true',
      });
    } catch (error) { if (error instanceof HttpError && error.status === 404) return undefined; throw error; }
  }

  private async findPayment(request: PaymentRequest): Promise<JsonObject | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.api('seller', `/payment/?network=Preprod&limit=100&includeHistory=true${cursor ? `&cursorId=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(result.Payments)) throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Payment list missing', 502);
      const entries = result.Payments.map((value) => object(value));
      const matches = entries.filter((entry) => {
        if (typeof entry.metadata !== 'string') return false;
        try { return object(JSON.parse(entry.metadata)).intent_id === request.intent_id; } catch { return false; }
      });
      if (matches.length > 1) throw new BusinessError('MASUMI_DUPLICATE_INTENT', 'Multiple provider payments require owner reconciliation', 409);
      if (matches[0]) { this.verify(matches[0], request, 'seller'); return matches[0]; }
      if (entries.length < 100) return undefined;
      const next = string(entries.at(-1)?.id, 'cursor');
      if (next === cursor) break;
      cursor = next;
    }
    throw new BusinessError('MASUMI_RECONCILIATION_REQUIRED', 'Payment history exceeds bounded lookup; do not create another payment', 409);
  }

  private verify(record: JsonObject, request: PaymentRequest, side: 'seller' | 'buyer', identifier?: string): void {
    const config = this.validate(request);
    const source = object(record.PaymentSource, 'PaymentSource');
    const agentIdentifier = config.skus[request.sku];
    if (source.network !== 'Preprod' || source.paymentType !== 'Web3CardanoV1'
      || source.policyId !== agentIdentifier.slice(0, 56) || record.inputHash !== request.input_hash
      || (identifier !== undefined && record.blockchainIdentifier !== identifier)) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Masumi network, policy, input or payment identifier mismatch', 502);
    }
    string(record.id, 'payment id');
    string(record.blockchainIdentifier, 'blockchain identifier');
    exactAmounts(side === 'seller' ? record.RequestedFunds : record.PaidFunds, request);
    const wallet = side === 'seller' ? record.SmartContractWallet : record.SellerWallet;
    if (side === 'seller' && typeof record.metadata === 'string') {
      let metadata: JsonObject;
      try { metadata = object(JSON.parse(record.metadata)); } catch { throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Payment intent metadata is invalid', 502); }
      if (metadata.intent_id !== request.intent_id || metadata.order_id !== request.order_id || metadata.sku !== request.sku) {
        throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Payment metadata differs from purchase intent', 502);
      }
    }
    if (wallet !== null && wallet !== undefined && object(wallet).walletVkey !== config.sellerVkey) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Seller verification key differs from the approved seller', 502);
    }
    if (side === 'seller' && (wallet === null || wallet === undefined)) {
      throw new BusinessError('MASUMI_IDENTITY_UNVERIFIED', 'Seller payment wallet is missing', 502);
    }
    if (side === 'buyer' && record.onChainState !== null && record.onChainState !== undefined
      && (wallet === null || wallet === undefined)) {
      throw new BusinessError('MASUMI_IDENTITY_UNVERIFIED', 'Funded purchase has no verified seller wallet', 502);
    }
  }

  private observation(request: PaymentRequest, payment?: JsonObject, purchase?: JsonObject,
    forcedState?: PaymentObservation['state']): PaymentObservation {
    if (payment) this.verify(payment, request, 'seller');
    if (purchase) this.verify(purchase, request, 'buyer', payment ? String(payment.blockchainIdentifier) : undefined);
    let state: PaymentObservation['state'] = forcedState ?? 'reconciliation_required';
    const record = purchase ?? payment;
    let transactionHash: string | undefined;
    if (purchase && !forcedState) {
      const tx = purchase.CurrentTransaction === null || purchase.CurrentTransaction === undefined ? undefined : object(purchase.CurrentTransaction);
      if (tx?.status === 'FailedViaTimeout' || tx?.status === 'RolledBack') state = 'reconciliation_required';
      else switch (purchase.onChainState) {
        case 'FundsLocked': state = 'escrow_funded'; break;
        case 'ResultSubmitted': state = 'result_submitted'; break;
        case 'RefundRequested': state = 'refund_requested'; break;
        case 'RefundWithdrawn': {
          exactAmounts(purchase.WithdrawnForBuyer, request); state = 'refunded'; break;
        }
        case 'Withdrawn': {
          const payout = amounts(purchase.WithdrawnForSeller, 'seller payout');
          if (payout.length !== 1 || domainAsset(payout[0].unit) !== request.asset || BigInt(payout[0].amount) <= 0n
            || BigInt(payout[0].amount) > BigInt(request.asset_quantity)) {
            throw new BusinessError('MASUMI_PAYOUT_UNVERIFIED', 'Seller payout proof is missing or invalid', 502);
          }
          state = 'seller_paid'; break;
        }
        case 'FundsOrDatumInvalid': state = 'failed'; break;
        case 'Disputed': case 'DisputedWithdrawn': state = 'reconciliation_required'; break;
        case null: case undefined: {
          const next = object(purchase.NextAction, 'NextAction');
          state = next.errorType === 'InsufficientFunds' ? 'failed' : next.errorType ? 'reconciliation_required' : 'purchase_requested';
          break;
        }
        default: throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Unrecognized on-chain state', 502);
      }
      const transactions = Array.isArray(purchase.TransactionHistory) ? purchase.TransactionHistory.map((entry) => object(entry)) : [];
      const confirmed = tx?.status === 'Confirmed' ? tx : transactions.reverse().find((entry) => entry.status === 'Confirmed');
      if (confirmed && typeof confirmed.txHash === 'string' && /^[a-f0-9]{64}$/.test(confirmed.txHash)) transactionHash = confirmed.txHash;
      if (['escrow_funded', 'result_submitted', 'seller_paid', 'refunded'].includes(state) && !transactionHash) state = 'reconciliation_required';
    }
    if ((state === 'seller_paid' || state === 'refunded') && this.walletIntent === request.intent_id) this.walletIntent = undefined;
    return {
      provider: this.name, network: 'Preprod', state,
      ...(purchase ? { provider_payment_id: string(purchase.id, 'buyer purchase id') } : {}),
      ...(payment ? { seller_payment_id: string(payment.id, 'seller payment id') } : {}),
      ...(typeof record?.blockchainIdentifier === 'string' ? { blockchain_identifier: record.blockchainIdentifier } : {}),
      ...(transactionHash ? { transaction_hash: transactionHash } : {}),
      asset: request.asset, asset_quantity: request.asset_quantity, seller_id: request.seller_id,
      input_hash: request.input_hash, observed_at: this.now().toISOString(),
      raw: { api_version: MASUMI_VERSION, payment: payment ? this.publicRecord(payment) : undefined,
        purchase: purchase ? this.publicRecord(purchase) : undefined },
    };
  }

  private publicRecord(record: JsonObject): JsonObject {
    const keys = ['id', 'blockchainIdentifier', 'inputHash', 'resultHash', 'onChainState', 'payByTime', 'submitResultTime',
      'unlockTime', 'externalDisputeUnlockTime', 'RequestedFunds', 'PaidFunds', 'WithdrawnForSeller', 'WithdrawnForBuyer',
      'PaymentSource', 'SmartContractWallet', 'SellerWallet', 'CurrentTransaction', 'TransactionHistory'];
    const result = Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
    const nestedFields: Record<string, string[]> = {
      PaymentSource: ['id', 'network', 'policyId', 'paymentType', 'smartContractAddress'],
      SmartContractWallet: ['id', 'walletVkey', 'walletAddress'], SellerWallet: ['id', 'walletVkey'],
      CurrentTransaction: ['id', 'txHash', 'hash', 'status', 'createdAt', 'updatedAt'],
    };
    for (const [key, fields] of Object.entries(nestedFields)) {
      if (result[key] !== undefined && result[key] !== null) {
        const value = object(result[key]);
        result[key] = Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
      }
    }
    if (Array.isArray(result.TransactionHistory)) result.TransactionHistory = result.TransactionHistory.map((entry) => {
      const tx = object(entry);
      return Object.fromEntries(['id', 'txHash', 'hash', 'status', 'createdAt', 'updatedAt'].filter((key) => tx[key] !== undefined).map((key) => [key, tx[key]]));
    });
    for (const key of ['RequestedFunds', 'PaidFunds', 'WithdrawnForSeller', 'WithdrawnForBuyer']) {
      if (result[key] !== undefined) result[key] = amounts(result[key], key);
    }
    if (record.NextAction) {
      const next = object(record.NextAction);
      result.NextAction = { requestedAction: next.requestedAction, errorType: next.errorType, resultHash: next.resultHash };
    }
    return result;
  }

  async start(request: PaymentRequest): Promise<PaymentObservation> {
    return this.dispatchStart(request);
  }

  private async dispatchStart(request: PaymentRequest, existingPayment?: JsonObject): Promise<PaymentObservation> {
    const config = this.validate(request);
    if (!config.preprodPurchasesEnabled) {
      throw new BusinessError('MASUMI_PREPROD_PURCHASES_DISABLED', 'Operator must explicitly enable Preprod test purchases; this is not live verification', 503);
    }
    if (this.walletIntent && this.walletIntent !== request.intent_id) {
      throw new BusinessError('MASUMI_BUYER_WALLET_BUSY', 'Another purchase owns the buyer wallet lifecycle', 409);
    }
    const fingerprint = JSON.stringify([request.order_id, request.quote_id, request.input_hash,
      request.identifier_from_purchaser, request.sku, request.asset_quantity, request.max_network_fee]);
    const existing = this.activeStarts.get(request.intent_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Concurrent request changed the persisted payment intent');
      return existing.promise;
    }
    const promise = this.startOnce(request, existingPayment);
    this.activeStarts.set(request.intent_id, { fingerprint, promise });
    try { return await promise; } finally { this.activeStarts.delete(request.intent_id); }
  }

  private async startOnce(request: PaymentRequest, existingPayment?: JsonObject): Promise<PaymentObservation> {
    const config = this.validate(request);
    let payment: JsonObject;
    try { payment = existingPayment ?? await this.prepareSeller(request); }
    catch (error) {
      if (error instanceof BusinessError && error.code === 'MASUMI_TRANSPORT_UNCERTAIN') {
        return this.observation(request, undefined, undefined, 'reconciliation_required');
      }
      throw this.safeError(error);
    }
    this.verify(payment, request, 'seller');
    const identifier = string(payment.blockchainIdentifier, 'blockchain identifier');
    const existing = await this.resolve('buyer', identifier);
    if (existing) {
      this.claimWallet(request);
      return this.observation(request, payment, existing);
    }
    await this.verifyFeeBudget(request);
    this.claimWallet(request);
    try {
      const purchase = await this.api('buyer', '/purchase/', {
        network: 'Preprod', paymentType: 'Web3CardanoV1', agentIdentifier: config.skus[request.sku],
        inputHash: request.input_hash, identifierFromPurchaser: request.identifier_from_purchaser,
        sellerVkey: config.sellerVkey, blockchainIdentifier: identifier,
        payByTime: validTimestamp(payment.payByTime), submitResultTime: validTimestamp(payment.submitResultTime),
        unlockTime: validTimestamp(payment.unlockTime), externalDisputeUnlockTime: validTimestamp(payment.externalDisputeUnlockTime),
        metadata: JSON.stringify({ intent_id: request.intent_id, order_id: request.order_id, sku: request.sku }),
      });
      return this.observation(request, payment, purchase);
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'MASUMI_TRANSPORT_UNCERTAIN') return this.observation(request, payment, undefined, 'reconciliation_required');
      if (error instanceof HttpError && [400, 409].includes(error.status)) {
        const existingPurchase = await this.resolve('buyer', identifier);
        if (existingPurchase) return this.observation(request, payment, existingPurchase);
      }
      throw this.safeError(error);
    }
  }

  private async prepareSeller(request: PaymentRequest): Promise<JsonObject> {
    const config = this.validate(request);
    const fingerprint = JSON.stringify([request.input_hash, request.identifier_from_purchaser, request.order_id, request.sku]);
    const active = this.sellerPreparations.get(request.intent_id);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Concurrent seller preparation changed the payment intent');
      return active.promise;
    }
    const promise = (async () => {
      const existing = await this.findPayment(request);
      if (existing) return existing;
      const created = this.now().getTime();
      const [pay, result, unlock, external] = config.deadlineProfile === 'preprod_smoke' ? [5, 16, 32, 48] : [20, 60, 90, 120];
      const payment = await this.api('seller', '/payment/', {
        network: 'Preprod', paymentType: 'Web3CardanoV1', agentIdentifier: config.skus[request.sku],
        inputHash: request.input_hash, identifierFromPurchaser: request.identifier_from_purchaser,
        payByTime: new Date(created + pay * 60_000).toISOString(), submitResultTime: new Date(created + result * 60_000).toISOString(),
        unlockTime: new Date(created + unlock * 60_000).toISOString(), externalDisputeUnlockTime: new Date(created + external * 60_000).toISOString(),
        metadata: JSON.stringify({ intent_id: request.intent_id, order_id: request.order_id, sku: request.sku }),
      });
      this.verify(payment, request, 'seller');
      return payment;
    })();
    this.sellerPreparations.set(request.intent_id, { fingerprint, promise });
    try { return await promise; } finally { this.sellerPreparations.delete(request.intent_id); }
  }

  /** MIP-003 preparation only: no buyer lookup, wallet signing or purchase call. */
  async prepareJob(request: PaymentRequest): Promise<PaymentJob> {
    const config = this.validate(request);
    let payment: JsonObject;
    try { payment = await this.prepareSeller(request); } catch (error) { throw this.safeError(error); }
    this.verify(payment, request, 'seller');
    const toSeconds = (value: unknown) => Math.floor(Number(validTimestamp(value)) / 1000);
    const payByTime = toSeconds(payment.payByTime);
    const submitResultTime = toSeconds(payment.submitResultTime);
    const unlockTime = toSeconds(payment.unlockTime);
    const externalDisputeUnlockTime = toSeconds(payment.externalDisputeUnlockTime);
    if (payByTime >= submitResultTime || submitResultTime >= unlockTime || unlockTime >= externalDisputeUnlockTime) {
      throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Seller job deadlines are not ordered', 502);
    }
    return { id: request.intent_id, blockchainIdentifier: string(payment.blockchainIdentifier, 'blockchain identifier'),
      payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, agentIdentifier: config.skus[request.sku],
      sellerVKey: config.sellerVkey, identifierFromPurchaser: request.identifier_from_purchaser, input_hash: request.input_hash };
  }

  /** Explicit owner operation only; background reconciliation must use observe(). */
  async resumePurchase(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation> {
    this.verifyPrevious(request, previous);
    const current = await this.observe(request, previous);
    if (current.provider_payment_id) return current;
    if (!['created', 'purchase_requested', 'reconciliation_required'].includes(current.state)
      || !current.blockchain_identifier || !current.seller_payment_id) {
      throw new BusinessError('MASUMI_RESUME_UNSAFE', 'Authoritative existing seller payment is required; no new payment will be created', 409);
    }
    const payment = await this.resolve('seller', current.blockchain_identifier);
    if (!payment) throw new BusinessError('MASUMI_RESUME_UNSAFE', 'Seller request disappeared; owner reconciliation is required', 409);
    this.verify(payment, request, 'seller', current.blockchain_identifier);
    if (payment.id !== current.seller_payment_id) throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Seller request changed before owner resume', 502);
    if (BigInt(validTimestamp(payment.payByTime)) <= BigInt(this.now().getTime())) {
      throw new BusinessError('MASUMI_RESUME_EXPIRED', 'Original payment deadline expired; owner must reconcile without charging again', 409);
    }
    // Reuse the exact signed identifier. The pinned node has both an existing-purchase
    // guard and a database UNIQUE constraint on PurchaseRequest.blockchainIdentifier.
    return this.dispatchStart(request, payment);
  }

  async observe(request: PaymentRequest, previous?: PaymentObservation): Promise<PaymentObservation> {
    this.validate(request);
    if (previous) this.verifyPrevious(request, previous);
    const payment = previous?.blockchain_identifier
      ? await this.resolve('seller', previous.blockchain_identifier) : await this.findPayment(request);
    if (!payment) return this.observation(request, undefined, undefined, 'reconciliation_required');
    this.verify(payment, request, 'seller', previous?.blockchain_identifier);
    if (previous?.seller_payment_id && previous.seller_payment_id !== payment.id) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Seller payment id changed during reconciliation', 502);
    }
    const purchase = await this.resolve('buyer', string(payment.blockchainIdentifier, 'blockchain identifier'));
    if (previous?.provider_payment_id && (!purchase || previous.provider_payment_id !== purchase.id)) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Previously verified buyer purchase id changed or disappeared', 502);
    }
    if (purchase) this.claimWallet(request);
    return this.observation(request, payment, purchase);
  }

  async submitResult(request: PaymentRequest, previous: PaymentObservation, resultHash: string): Promise<PaymentObservation> {
    this.verifyPrevious(request, previous);
    if (!/^[a-f0-9]{64}$/.test(resultHash)) throw new BusinessError('PAYMENT_INVALID_RESULT_HASH', 'SHA-256 result hash required');
    const current = await this.observe(request, previous);
    if (!['escrow_funded', 'result_submitted', 'seller_paid'].includes(current.state)) throw new BusinessError('PAYMENT_NOT_FUNDED', 'Confirmed escrow required before result submission');
    const raw = object(current.raw);
    const payment = object(raw.payment);
    if (current.state === 'result_submitted' || current.state === 'seller_paid') {
      if (payment.resultHash !== resultHash) throw new BusinessError('PAYMENT_RESULT_MISMATCH', 'Result hash differs from on-chain delivery');
      return current;
    }
    const next = payment.NextAction ? object(payment.NextAction) : undefined;
    if (next && ['SubmitResultRequested', 'SubmitResultInitiated'].includes(String(next.requestedAction))) {
      if (next.resultHash !== resultHash) throw new BusinessError('PAYMENT_RESULT_MISMATCH', 'Pending delivery has a different result hash');
      return current;
    }
    try {
      await this.api('seller', '/payment/submit-result', { network: 'Preprod', blockchainIdentifier: current.blockchain_identifier, submitResultHash: resultHash });
    } catch (error) { if (!(error instanceof BusinessError && error.code === 'MASUMI_TRANSPORT_UNCERTAIN')) throw this.safeError(error); }
    return this.observe(request, current);
  }

  async requestRefund(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation> {
    this.verifyPrevious(request, previous);
    const current = await this.observe(request, previous);
    if (current.state === 'refund_requested' || current.state === 'refunded') return current;
    if (!['escrow_funded', 'result_submitted'].includes(current.state)) throw new BusinessError('PAYMENT_REFUND_UNAVAILABLE', 'No refundable escrow; payout requires owner compensation');
    const payment = object(object(current.raw).payment);
    if (BigInt(validTimestamp(payment.unlockTime)) <= BigInt(this.now().getTime())) throw new BusinessError('PAYMENT_REFUND_WINDOW_CLOSED', 'Escrow dispute window has expired');
    try {
      await this.api('buyer', '/purchase/request-refund', { network: 'Preprod', blockchainIdentifier: current.blockchain_identifier });
    } catch (error) { if (!(error instanceof BusinessError && error.code === 'MASUMI_TRANSPORT_UNCERTAIN')) throw this.safeError(error); }
    return this.observe(request, current);
  }

  /** Explicit owner authorization; never called by customer requestRefund(). */
  async authorizeRefund(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation> {
    this.verifyPrevious(request, previous);
    const current = await this.observe(request, previous);
    if (current.state === 'refunded') return current;
    if (current.state !== 'refund_requested') {
      throw new BusinessError('PAYMENT_REFUND_UNAVAILABLE', 'An observed buyer refund request is required before seller authorization', 409);
    }
    try {
      await this.api('seller', '/payment/authorize-refund', {
        network: 'Preprod', blockchainIdentifier: current.blockchain_identifier,
      });
    } catch (error) {
      if (!(error instanceof BusinessError && error.code === 'MASUMI_TRANSPORT_UNCERTAIN')) throw this.safeError(error);
      return { ...current, state: 'reconciliation_required', observed_at: this.now().toISOString() };
    }
    return this.observe(request, current);
  }

  private verifyPrevious(request: PaymentRequest, previous: PaymentObservation): void {
    this.validate(request);
    if (previous.provider !== this.name || previous.network !== 'Preprod' || previous.input_hash !== request.input_hash
      || previous.seller_id !== request.seller_id || previous.asset !== request.asset || previous.asset_quantity !== request.asset_quantity) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Observation differs from purchase authorization');
    }
  }

  private async verifyFeeBudget(request: PaymentRequest): Promise<void> {
    const config = this.configured();
    if (!config.dedicatedBuyerWallet || !config.buyerWalletAddress || !config.buyerLifecycleIsolated) {
      throw new BusinessError('MASUMI_FEE_CAP_NOT_ENFORCED', 'Pinned API has no fee cap; verified wallet isolation, an external lifecycle fence and a bounded balance are required', 503);
    }
    const wallets = await this.api('buyer', '/payment-source/?take=100');
    if (!Array.isArray(wallets.PaymentSources)) throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Payment sources missing', 502);
    if (wallets.PaymentSources.length >= 100) throw new BusinessError('MASUMI_FEE_CAP_NOT_ENFORCED', 'Cannot prove all purchasing wallets with a bounded source list', 503);
    const purchasingAddresses: string[] = [];
    for (const entry of wallets.PaymentSources) {
      const source = object(entry);
      if (source.network !== 'Preprod') continue;
      if (!Array.isArray(source.PurchasingWallets)) continue;
      for (const wallet of source.PurchasingWallets) purchasingAddresses.push(string(object(wallet).walletAddress, 'buyer wallet address'));
    }
    if (purchasingAddresses.length !== 1 || purchasingAddresses[0] !== config.buyerWalletAddress) {
      throw new BusinessError('MASUMI_FEE_CAP_NOT_ENFORCED', 'Buyer node must expose exactly the configured isolated purchasing wallet', 503);
    }
    let balance = 0n;
    for (let page = 1; page <= 100; page++) {
      const result = await this.api('buyer', `/utxos/?network=Preprod&address=${encodeURIComponent(config.buyerWalletAddress)}&count=100&page=${page}&order=asc`);
      if (!Array.isArray(result.Utxos)) throw new BusinessError('MASUMI_INVALID_RESPONSE', 'UTXO list missing', 502);
      for (const value of result.Utxos) {
        const utxo = object(value);
        if (utxo.address !== config.buyerWalletAddress || !Array.isArray(utxo.Amounts)) throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Unexpected wallet UTXO', 502);
        for (const entry of utxo.Amounts) {
          const amount = object(entry);
          if (amount.unit === '' || amount.unit === 'lovelace') {
            if (!Number.isSafeInteger(amount.quantity) || Number(amount.quantity) < 0) throw new BusinessError('MASUMI_INVALID_RESPONSE', 'Unsafe wallet quantity', 502);
            balance += BigInt(Number(amount.quantity));
          }
        }
      }
      if (result.Utxos.length < 100) break;
      if (page === 100) throw new BusinessError('MASUMI_FEE_CAP_NOT_ENFORCED', 'Wallet balance lookup exceeds bound', 503);
    }
    if (balance < BigInt(request.asset_quantity)) throw new BusinessError('MASUMI_INSUFFICIENT_FUNDS', 'Buyer wallet cannot cover registered price', 409);
    if (balance > BigInt(request.asset_quantity) + integer(request.max_network_fee, 'max_network_fee')) {
      throw new BusinessError('MASUMI_FEE_CAP_NOT_ENFORCED', 'Wallet balance exceeds purchase plus authorized fee budget', 409);
    }
  }

  private claimWallet(request: PaymentRequest): void {
    if (this.walletIntent && this.walletIntent !== request.intent_id) {
      throw new BusinessError('MASUMI_BUYER_WALLET_BUSY', 'Another purchase owns the buyer wallet until confirmed payout/refund or owner reconciliation', 409);
    }
    this.walletIntent = request.intent_id;
  }

  private safeError(error: unknown): Error {
    if (error instanceof HttpError) return new BusinessError('MASUMI_HTTP_ERROR', error.message, 502);
    if (error instanceof BusinessError) return error;
    return new BusinessError('MASUMI_UNEXPECTED_ERROR', 'Masumi operation failed; reconciliation required', 502);
  }
}
