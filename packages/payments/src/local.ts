import { createHash } from 'node:crypto';
import { BusinessError, type PaymentJob, type PaymentObservation, type PaymentProvider, type PaymentRequest } from '../../contracts/index.js';
import { DEMO_SELLER, object, validateRequest } from './common.js';

export interface LocalDemoOptions {
  scenario?: 'immediate' | 'delayed' | 'failed';
  delayObservations?: number;
  payoutObservations?: number;
  now?: () => Date;
}

/** Synthetic provider. No signature, transaction hash or state here is blockchain evidence. */
export class LocalDemoProvider implements PaymentProvider {
  readonly name = 'local_demo' as const;
  private readonly now: () => Date;
  constructor(private readonly options: LocalDemoOptions = {}) { this.now = options.now ?? (() => new Date()); }

  private observation(request: PaymentRequest, state: PaymentObservation['state'], polls = 0, resultHash?: string): PaymentObservation {
    validateRequest(request, this.name, DEMO_SELLER);
    const id = `demo:${createHash('sha256').update(request.intent_id).digest('hex')}`;
    return {
      provider: this.name, network: 'local', state, provider_payment_id: id, transaction_hash: id,
      asset: request.asset, asset_quantity: request.asset_quantity, seller_id: request.seller_id,
      input_hash: request.input_hash, observed_at: this.now().toISOString(),
      raw: { simulation: true, notice: 'Local simulation; not a Masumi blockchain payment', polls, result_hash: resultHash },
    };
  }

  async start(request: PaymentRequest): Promise<PaymentObservation> {
    return this.observation(request, this.options.scenario === 'failed' ? 'failed'
      : this.options.scenario === 'delayed' ? 'purchase_requested' : 'escrow_funded');
  }

  async prepareJob(request: PaymentRequest): Promise<PaymentJob & { simulation: true; provider: 'local_demo' }> {
    validateRequest(request, this.name, DEMO_SELLER);
    const created = Date.parse(request.created_at);
    if (!Number.isFinite(created)) throw new BusinessError('PAYMENT_INVALID_IDENTIFIER', 'Persisted job creation time required');
    const seconds = (minutes: number) => Math.floor((created + minutes * 60_000) / 1000);
    return { id: request.intent_id, blockchainIdentifier: `demo:${createHash('sha256').update(request.intent_id).digest('hex')}`,
      payByTime: seconds(20), submitResultTime: seconds(60), unlockTime: seconds(90), externalDisputeUnlockTime: seconds(120),
      agentIdentifier: 'demo:pneu007', sellerVKey: DEMO_SELLER, identifierFromPurchaser: request.identifier_from_purchaser,
      input_hash: request.input_hash, simulation: true, provider: this.name };
  }

  async observe(request: PaymentRequest, previous?: PaymentObservation): Promise<PaymentObservation> {
    if (!previous) return this.start(request);
    this.validatePrevious(request, previous);
    const raw = object(previous.raw);
    const polls = typeof raw.polls === 'number' ? raw.polls + 1 : 1;
    let state = previous.state;
    if (state === 'purchase_requested' && polls >= (this.options.delayObservations ?? 2)) state = 'escrow_funded';
    if (state === 'result_submitted' && polls >= (this.options.payoutObservations ?? 1)) state = 'seller_paid';
    if (state === 'refund_requested') state = 'refunded';
    return this.observation(request, state, polls, typeof raw.result_hash === 'string' ? raw.result_hash : undefined);
  }

  async submitResult(request: PaymentRequest, previous: PaymentObservation, resultHash: string): Promise<PaymentObservation> {
    this.validatePrevious(request, previous);
    if (!/^[a-f0-9]{64}$/.test(resultHash)) throw new BusinessError('PAYMENT_INVALID_RESULT_HASH', 'SHA-256 result hash required');
    if (!['escrow_funded', 'result_submitted', 'seller_paid'].includes(previous.state)) {
      throw new BusinessError('PAYMENT_NOT_FUNDED', 'Cannot deliver an unfunded purchase');
    }
    if (previous.state === 'seller_paid') return previous;
    return this.observation(request, 'result_submitted', 0, resultHash);
  }

  async requestRefund(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation> {
    this.validatePrevious(request, previous);
    if (previous.state === 'refunded' || previous.state === 'refund_requested') return previous;
    if (!['escrow_funded', 'result_submitted'].includes(previous.state)) {
      throw new BusinessError('PAYMENT_REFUND_UNAVAILABLE', 'No refundable escrow; payout needs owner compensation');
    }
    return this.observation(request, 'refund_requested');
  }

  private validatePrevious(request: PaymentRequest, previous: PaymentObservation): void {
    const expected = this.observation(request, 'created');
    if (previous.provider !== this.name || previous.network !== 'local' || previous.provider_payment_id !== expected.provider_payment_id
      || previous.input_hash !== request.input_hash || previous.asset !== request.asset
      || previous.asset_quantity !== request.asset_quantity || previous.seller_id !== request.seller_id) {
      throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Observation belongs to another purchase');
    }
  }
}
