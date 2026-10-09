import { createHash } from 'node:crypto';
import type { LegacyStore, PaymentIntent } from '../../../packages/demo-garage/index.js';
import { BusinessError, type PaymentProvider } from '../../../packages/contracts/index.js';

export interface Receipt {
  booking_id: string; order_id: string; quote_id: string; intent_id: string;
  slot_id: string; start_at: string; end_at: string; total_minor: number;
  amount_paid_minor: number; balance_minor: number; payment_mode: string;
  provider: string; network: string; asset: string; asset_quantity: string;
  fulfilment: 'confirmed_fictional_reservation';
}
/** The database is local/atomic. Every provider step is separate and restart-safe. */
export class PaymentWorkflow {
  private readonly inFlight = new Map<string, Promise<PaymentIntent>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly store: LegacyStore, readonly provider: PaymentProvider) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS legacy_receipts(intent_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, result_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_workflow_errors(intent_id TEXT PRIMARY KEY, code TEXT NOT NULL, at TEXT NOT NULL);`);
  }
  private receipt(intent: PaymentIntent): { value: Receipt; hash: string; encoded: string } | undefined {
    const stored = this.store.db.prepare('SELECT * FROM legacy_receipts WHERE intent_id=?').get(intent.intent_id) as { receipt_json: string; result_hash: string } | undefined;
    if (stored) return { value: JSON.parse(stored.receipt_json) as Receipt, hash: stored.result_hash, encoded: stored.receipt_json };
    const order = this.store.getOrder(intent.order_id);
    const booking = this.store.calendar(order.customer_id).find(value => value.order_id === order.id && value.status === 'confirmed');
    if (!booking || order.status !== 'confirmed') return undefined;
    const quote = this.store.getQuote(order.quote_id);
    const value: Receipt = { booking_id: booking.id, order_id: order.id, quote_id: quote.id, intent_id: intent.intent_id,
      slot_id: booking.slot_id, start_at: booking.start_at, end_at: booking.end_at,
      total_minor: quote.price.total_minor, amount_paid_minor: intent.amount_minor, balance_minor: order.balance_minor,
      payment_mode: intent.payment_mode, provider: intent.provider, network: intent.network,
      asset: intent.asset, asset_quantity: intent.asset_quantity, fulfilment: 'confirmed_fictional_reservation' };
    const encoded = JSON.stringify(value);
    const hash = createHash('sha256').update(intent.provider === 'masumi' ? `${intent.identifier_from_purchaser};${encoded}` : encoded).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO legacy_receipts VALUES(?,?,?)').run(intent.intent_id, encoded, hash);
    return { value, hash, encoded };
  }
  getReceipt(intentId: string) { return this.receipt(this.store.getPaymentIntent(intentId))?.value; }
  getResult(intentId: string) { return this.receipt(this.store.getPaymentIntent(intentId))?.encoded; }
  error(intentId: string) { return this.store.db.prepare('SELECT code,at FROM payment_workflow_errors WHERE intent_id=?').get(intentId); }
  reconcile(intentId: string): Promise<PaymentIntent> {
    const running = this.inFlight.get(intentId);
    if (running) return running;
    const work = this.process(intentId).finally(() => { if (this.inFlight.get(intentId) === work) this.inFlight.delete(intentId); });
    this.inFlight.set(intentId, work);
    return work;
  }
  private async process(intentId: string): Promise<PaymentIntent> {
    let intent = this.store.getPaymentIntent(intentId);
    if (['failed', 'refunded', 'seller_paid'].includes(intent.state)) return intent;
    try {
      if (intent.state === 'created') {
        intent = this.store.markPurchaseRequested(intentId);
        intent = this.store.recordPaymentObservation(intentId, await this.provider.start(intent));
      } else {
        intent = this.store.recordPaymentObservation(intentId, await this.provider.observe(intent, intent.observation));
      }
      const order = this.store.getOrder(intent.order_id);
      if (['cancel_requested', 'refund_pending', 'cancelled'].includes(order.status) && intent.observation
        && ['escrow_funded', 'result_submitted'].includes(intent.observation.state)) {
        intent = this.store.recordPaymentObservation(intentId, await this.provider.requestRefund(intent, intent.observation));
      } else if (order.status === 'refund_pending' && intent.observation?.state === 'seller_paid') {
        throw new BusinessError('MANUAL_COMPENSATION_REQUIRED', 'Výplata prodejci již proběhla; majitel musí vyřešit samostatnou kompenzaci.', 409);
      } else if (intent.state === 'escrow_funded' && intent.observation) {
        const result = this.receipt(intent);
        if (result) intent = this.store.recordPaymentObservation(intentId, await this.provider.submitResult(intent, intent.observation, result.hash));
      }
      this.store.db.prepare('DELETE FROM payment_workflow_errors WHERE intent_id=?').run(intentId);
      return intent;
    } catch (error) {
      const code = error instanceof BusinessError ? error.code : 'PROVIDER_TEMPORARILY_UNAVAILABLE';
      // Do not manufacture a provider ID/state or unlock the hold after ambiguous network failure.
      this.store.db.prepare('INSERT INTO payment_workflow_errors VALUES(?,?,?) ON CONFLICT(intent_id) DO UPDATE SET code=excluded.code,at=excluded.at')
        .run(intentId, code, new Date().toISOString());
      return this.store.getPaymentIntent(intentId);
    }
  }
  async requestRefund(intentId: string): Promise<PaymentIntent> {
    const running = this.inFlight.get(intentId);
    const work = (running ? running.then(() => this.performRefund(intentId)) : this.performRefund(intentId))
      .finally(() => { if (this.inFlight.get(intentId) === work) this.inFlight.delete(intentId); });
    this.inFlight.set(intentId, work);
    return work;
  }
  private async performRefund(intentId: string): Promise<PaymentIntent> {
    const intent = this.store.getPaymentIntent(intentId);
    if (!intent.observation) throw new BusinessError('PAYMENT_UNCERTAIN', 'Nejdřív je nutné ověřit původní platbu.', 409);
    if (intent.state === 'refunded' || intent.state === 'refund_requested') return intent;
    if (intent.observation.state === 'seller_paid') throw new BusinessError('MANUAL_COMPENSATION_REQUIRED', 'Vyplacené prostředky vyžadují samostatnou kompenzaci majitelem.', 409);
    if (!['escrow_funded', 'result_submitted'].includes(intent.observation.state)) throw new BusinessError('PAYMENT_UNCERTAIN', 'Refund vyžaduje ověřené financované escrow.', 409);
    return this.store.recordPaymentObservation(intentId, await this.provider.requestRefund(intent, intent.observation));
  }
  ownerOperation(intentId: string, action: 'resume' | 'authorize_refund'): Promise<PaymentIntent> {
    const previous = this.inFlight.get(intentId);
    const perform = async () => {
      let intent = this.store.getPaymentIntent(intentId);
      if (action === 'resume') {
        if (!this.provider.resumePurchase) throw new BusinessError('RESUME_UNSUPPORTED', 'Provider nepodporuje bezpečné obnovení.', 409);
        if (!['purchase_requested', 'reconciliation_required'].includes(intent.state)) throw new BusinessError('RESUME_FORBIDDEN', 'Obnovit lze jen nevyřešené zahájení nákupu.', 409);
        const order = this.store.getOrder(intent.order_id);
        if (['cancel_requested', 'cancelled', 'refund_pending', 'refunded'].includes(order.status)) throw new BusinessError('RESUME_FORBIDDEN', 'Stornovaný nákup se znovu nespouští.', 409);
        if (intent.provider === 'masumi' && this.store.listPaymentIntents().some(other => other.intent_id !== intentId && other.provider === 'masumi' && !['created', 'failed', 'refunded', 'seller_paid'].includes(other.state))) {
          throw new BusinessError('MASUMI_BUYER_WALLET_BUSY', 'Jiný nákup stále vlastní lifecycle peněženky.', 409);
        }
        intent = this.store.recordPaymentObservation(intentId, await this.provider.resumePurchase(intent, intent.observation));
      } else {
        if (!this.provider.authorizeRefund || !intent.observation || intent.observation.state !== 'refund_requested') throw new BusinessError('REFUND_AUTHORIZATION_UNAVAILABLE', 'Autorizace vyžaduje ověřenou žádost o refund.', 409);
        intent = this.store.recordPaymentObservation(intentId, await this.provider.authorizeRefund(intent, intent.observation));
      }
      return intent;
    };
    const work = (previous ? previous.then(perform) : perform()).finally(() => { if (this.inFlight.get(intentId) === work) this.inFlight.delete(intentId); });
    this.inFlight.set(intentId, work);
    return work;
  }
  private acceptedForDispatch(intent:PaymentIntent):boolean {
    // A restart may occur after native acceptance and before provider dispatch.
    // Seller-only MIP jobs are not buyer-dispatch authorizations.
    const tables=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('handoru_operations','human_checkout_authorizations')").all() as {name:string}[];
    if(tables.some(t=>t.name==='handoru_operations')&&this.store.db.prepare("SELECT 1 FROM handoru_operations WHERE kind='orders.checkout' AND json_extract(result_json,'$.intent_id')=?").get(intent.intent_id))return true;
    return tables.some(t=>t.name==='human_checkout_authorizations')&&Boolean(this.store.db.prepare('SELECT 1 FROM human_checkout_authorizations WHERE order_id=?').get(intent.order_id));
  }
  start(intervalMs: number) {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      for (const intent of this.store.listPaymentIntents()) if (!['failed', 'refunded', 'seller_paid'].includes(intent.state) && (intent.state!=='created'||this.acceptedForDispatch(intent))) {
        void this.reconcile(intent.intent_id).catch(() => undefined);
      }
    }, intervalMs);
    this.timer.unref();
  }
  async close() { if (this.timer) clearInterval(this.timer); await Promise.allSettled(this.inFlight.values()); }
}
