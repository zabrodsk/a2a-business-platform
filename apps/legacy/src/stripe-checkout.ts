import { createHmac, timingSafeEqual } from 'node:crypto';
import { BusinessError } from '../../../packages/contracts/index.js';
import { type LegacyStore, type StripeCheckout, type StripeSession, type StripePaymentIntentProof } from '../../../packages/demo-garage/index.js';

const API = 'https://api.stripe.com/v1';
const API_VERSION = '2026-09-30.endive';
const CHECKOUT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired']);
const terminal = (checkout: StripeCheckout) => ['paid', 'expired', 'failed'].includes(checkout.state);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (code: string, status = 503) => new BusinessError(code, 'Platbu přes Stripe nelze bezpečně ověřit. Zkuste ověřit původní platbu znovu.', status);

interface Options {
  env: NodeJS.ProcessEnv;
  publicUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Hosted test Checkout. Provider payment confirmation never represents a bank payout. */
export class StripeCheckoutWorkflow {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => Date;
  private readonly inFlight = new Map<string, Promise<StripeCheckout>>();
  private accountCheck?: Promise<void>;
  private accountVerifiedUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private cursor = 0;
  private closed = false;

  constructor(readonly store: LegacyStore, private readonly options: Options) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.now ?? (() => new Date());
    store.db.exec(`CREATE TABLE IF NOT EXISTS stripe_checkout_requests (
      checkout_id TEXT PRIMARY KEY, form_body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stripe_checkout_webhook_events (
      event_id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL, event_type TEXT NOT NULL, processed_at TEXT NOT NULL);`);
  }

  status() {
    const env = this.options.env;
    const missing: string[] = [];
    // rkcs_test is the restricted key issued by the official unclaimed CLI sandbox.
    if (!/^(?:sk|rk|rkcs)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? '')) missing.push('STRIPE_SECRET_KEY');
    if (!/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID ?? '')) missing.push('STRIPE_ACCOUNT_ID');
    if (!/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET ?? '')) missing.push('STRIPE_WEBHOOK_SECRET');
    try {
      const url = new URL(this.options.publicUrl);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
    } catch { missing.push('LEGACY_PUBLIC_URL'); }
    return { provider: 'stripe_link' as const, mode: 'test' as const, configured: missing.length === 0,
      ready: missing.length === 0, missing_configuration: missing };
  }

  private requireConfig() {
    if (!this.status().ready) throw failure('STRIPE_NOT_CONFIGURED');
  }

  async start(orderId: string, actor: { id: string; customer_id?: string }, input: { payment_mode: 'deposit' | 'full'; confirm: boolean }): Promise<StripeCheckout> {
    this.requireConfig();
    const order = this.store.getOrder(orderId);
    if (!actor.customer_id || order.customer_id !== actor.customer_id) throw failure('FORBIDDEN', 403);
    if (input.confirm !== true) throw failure('PAYMENT_CONFIRMATION_REQUIRED', 400);
    if (!['deposit', 'full'].includes(input.payment_mode)) throw failure('INVALID_PAYMENT_MODE', 400);
    const quote = this.store.getQuote(order.quote_id);
    // An unavailable or mismatched account must not reserve the customer's slot.
    await this.verifyAccount();
    const checkout = this.store.prepareStripeCheckout(orderId, {
      actor_id: actor.id, customer_id: actor.customer_id, quote_id: quote.id, quote_version: quote.version,
      payment_mode: input.payment_mode, approved_at: this.clock().toISOString(),
      stripe_account_id: this.options.env.STRIPE_ACCOUNT_ID!,
    });
    this.persistRequest(checkout);
    return this.reconcile(checkout.id);
  }

  private persistRequest(checkout: StripeCheckout): string {
    const saved = this.store.db.prepare('SELECT form_body FROM stripe_checkout_requests WHERE checkout_id=?').get(checkout.id) as { form_body: string } | undefined;
    if (saved) return saved.form_body;
    // A dispatched request without its original parameters must never be recreated.
    if (checkout.dispatched_at) throw failure('STRIPE_ORIGINAL_REQUEST_MISSING', 409);
    const success = new URL(`/objednavka/${encodeURIComponent(checkout.order_id)}`, this.options.publicUrl);
    success.searchParams.set('link', 'return');
    const cancel = new URL(success);
    cancel.searchParams.set('link', 'cancel');
    const params = new URLSearchParams({ mode: 'payment', locale: 'cs', client_reference_id: checkout.id,
      success_url: success.toString(), cancel_url: cancel.toString(),
      expires_at: String(Math.floor(new Date(checkout.expires_at).getTime() / 1000)),
      integration_identifier: checkout.integration_identifier,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'czk',
      'line_items[0][price_data][unit_amount]': String(checkout.amount_minor),
      'line_items[0][price_data][product_data][name]': checkout.payment_mode === 'deposit' ? 'Záloha na rezervaci PNEU007' : 'Rezervace PNEU007',
    });
    const metadata = { checkout_id: checkout.id, order_id: checkout.order_id, quote_id: checkout.quote_id,
      quote_version: String(checkout.quote_version), customer_id: checkout.customer_id,
      payment_mode: checkout.payment_mode, integration_identifier: checkout.integration_identifier };
    for (const [key, value] of Object.entries(metadata)) {
      params.set(`metadata[${key}]`, value);
      params.set(`payment_intent_data[metadata][${key}]`, value);
    }
    const body = params.toString();
    this.store.db.prepare('INSERT INTO stripe_checkout_requests(checkout_id,form_body) VALUES(?,?)').run(checkout.id, body);
    return body;
  }

  private async request(path: string, method = 'GET', body?: string, idempotencyKey?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.options.env.STRIPE_SECRET_KEY!}`, 'Stripe-Version': API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body });
    } catch { throw failure('STRIPE_TEMPORARILY_UNAVAILABLE'); }
    if (!response.ok) throw failure('STRIPE_API_REJECTED');
    try { return await response.json(); } catch { throw failure('STRIPE_RESPONSE_INVALID'); }
  }

  private async verifyAccount() {
    this.requireConfig();
    // Official unclaimed CLI sandbox keys cannot read /account. Their test account
    // ID comes from the private CLI result and all session reads stay key-scoped.
    if (this.options.env.STRIPE_SECRET_KEY!.startsWith('rkcs_test_')) return;
    if (this.accountVerifiedUntil > this.clock().getTime()) return;
    if (this.accountCheck) return this.accountCheck;
    this.accountCheck = (async () => {
      const account = await this.request('/account');
      if (!object(account) || account.id !== this.options.env.STRIPE_ACCOUNT_ID || account.object !== 'account') throw failure('STRIPE_ACCOUNT_MISMATCH', 409);
      this.accountVerifiedUntil = this.clock().getTime() + 300_000;
    })().finally(() => { this.accountCheck = undefined; });
    return this.accountCheck;
  }

  private session(value: unknown): StripeSession {
    if (!object(value) || value.object !== 'checkout.session' || typeof value.id !== 'string' || !/^cs_test_[A-Za-z0-9]+$/.test(value.id) ||
      value.livemode !== false || value.mode !== 'payment' || !['open', 'complete', 'expired'].includes(String(value.status)) ||
      !['paid', 'unpaid', 'no_payment_required'].includes(String(value.payment_status)) || !Number.isSafeInteger(value.amount_total) ||
      typeof value.currency !== 'string' || typeof value.client_reference_id !== 'string' || !object(value.metadata) ||
      Object.values(value.metadata).some(item => typeof item !== 'string') || !Number.isSafeInteger(value.expires_at) ||
      !Number.isSafeInteger(value.created) || (value.url !== null && typeof value.url !== 'string') ||
      (value.payment_intent !== null && (typeof value.payment_intent !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(value.payment_intent)))) {
      throw failure('STRIPE_RESPONSE_INVALID', 409);
    }
    if (value.url !== null) {
      let url: URL;
      try { url = new URL(value.url as string); } catch { throw failure('STRIPE_CHECKOUT_URL_INVALID', 409); }
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password ||
        (url.port && url.port !== '443') || url.pathname !== `/c/pay/${value.id}`) throw failure('STRIPE_CHECKOUT_URL_INVALID', 409);
    }
    if (value.payment_status === 'paid' && (value.status !== 'complete' || !value.payment_intent)) throw failure('STRIPE_PAYMENT_PROOF_INVALID', 409);
    return { id: value.id, livemode: false, mode: 'payment', status: value.status as StripeSession['status'],
      payment_status: value.payment_status as StripeSession['payment_status'], amount_total: value.amount_total as number,
      currency: value.currency, client_reference_id: value.client_reference_id, metadata: value.metadata as Record<string, string>,
      expires_at: value.expires_at as number, created: value.created as number, url: value.url as string | null,
      payment_intent: value.payment_intent as string | null, stripe_account_id: this.options.env.STRIPE_ACCOUNT_ID! };
  }

  reconcile(checkoutId: string): Promise<StripeCheckout> {
    const pending = this.inFlight.get(checkoutId);
    if (pending) return pending;
    return this.run(checkoutId, () => this.process(checkoutId));
  }

  private run(checkoutId: string, perform: () => Promise<StripeCheckout>): Promise<StripeCheckout> {
    const previous = this.inFlight.get(checkoutId);
    const work = (previous ? previous.catch(() => undefined).then(perform) : perform())
      .finally(() => { if (this.inFlight.get(checkoutId) === work) this.inFlight.delete(checkoutId); });
    this.inFlight.set(checkoutId, work);
    return work;
  }

  private apply(checkoutId: string, session: StripeSession): StripeCheckout {
    return this.store.recordStripeSession(checkoutId, session);
  }

  private parseSession(checkoutId: string, value: unknown) {
    try { return this.session(value); }
    catch (error) {
      this.store.markStripeCheckoutReconciliation(checkoutId, error instanceof BusinessError ? error.code : 'STRIPE_RESPONSE_INVALID');
      throw error;
    }
  }

  private paymentIntent(checkout: StripeCheckout, session: StripeSession, value: unknown) {
    const identityKeys = ['checkout_id', 'order_id', 'quote_id', 'quote_version', 'customer_id', 'payment_mode', 'integration_identifier'];
    if (!object(value) || value.object !== 'payment_intent' || value.id !== session.payment_intent ||
      typeof value.id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(value.id) || value.livemode !== false ||
      value.amount !== checkout.amount_minor || value.currency !== 'czk' || typeof value.status !== 'string' ||
      !object(value.metadata) || identityKeys.some(key => (value.metadata as Record<string, unknown>)[key] !== session.metadata[key])) {
      throw failure('STRIPE_PAYMENT_INTENT_MISMATCH', 409);
    }
    return { id: value.id, object: 'payment_intent' as const, livemode: false as const, amount: checkout.amount_minor,
      currency: 'czk' as const, stripe_account_id: checkout.stripe_account_id,
      metadata: value.metadata as Record<string, string>, status: value.status, amount_received: value.amount_received,
      last_payment_error: value.last_payment_error };
  }

  private async settleFailure(checkoutId: string, session: StripeSession, eventId: string): Promise<StripeCheckout> {
    try {
      const checkout = this.store.getStripeCheckout(checkoutId);
      if (checkout.state === 'paid') return checkout;
      if (session.status !== 'complete' || session.payment_status !== 'unpaid' || !session.payment_intent) {
        throw failure('STRIPE_PAYMENT_FAILURE_UNCONFIRMED', 409);
      }
      const path = `/payment_intents/${encodeURIComponent(session.payment_intent)}`;
      const intent = this.paymentIntent(checkout, session, await this.request(path));
      // Checkout-owned intents cannot be canceled directly in this state. The
      // signed terminal failure event plus these provider reads is the evidence;
      // processing/action/capture/success states cannot release a reservation.
      if (!['requires_payment_method', 'canceled'].includes(intent.status) || intent.amount_received !== 0 ||
        (intent.status === 'requires_payment_method' && !object(intent.last_payment_error))) throw failure('STRIPE_PAYMENT_FAILURE_UNCONFIRMED', 409);
      const error = object(intent.last_payment_error) ? {
        ...(typeof intent.last_payment_error.type === 'string' ? { type: intent.last_payment_error.type } : {}),
        ...(typeof intent.last_payment_error.code === 'string' ? { code: intent.last_payment_error.code } : {}),
      } : null;
      const proof: StripePaymentIntentProof = { ...intent, status: intent.status as 'canceled' | 'requires_payment_method',
        amount_received: 0, last_payment_error: error,
        failure_event: { id: eventId, type: 'checkout.session.async_payment_failed', session_id: session.id } };
      return this.store.failStripeCheckout(checkoutId, session, proof);
    } catch (error) {
      this.store.markStripeCheckoutReconciliation(checkoutId, error instanceof BusinessError ? error.code : 'STRIPE_PAYMENT_FAILURE_UNCONFIRMED');
      throw error;
    }
  }

  private async process(checkoutId: string): Promise<StripeCheckout> {
    this.requireConfig();
    const checkout = this.store.getStripeCheckout(checkoutId);
    if (terminal(checkout)) return checkout;
    if (checkout.stripe_account_id !== this.options.env.STRIPE_ACCOUNT_ID) throw failure('STRIPE_ACCOUNT_MISMATCH', 409);
    await this.verifyAccount();
    if (checkout.session_id) {
      const session = this.parseSession(checkout.id, await this.request(`/checkout/sessions/${encodeURIComponent(checkout.session_id)}`));
      if (session.id !== checkout.session_id) {
        this.store.markStripeCheckoutReconciliation(checkout.id, 'STRIPE_SESSION_MISMATCH');
        throw failure('STRIPE_SESSION_MISMATCH', 409);
      }
      return this.apply(checkout.id, session);
    }
    if (checkout.dispatched_at && this.clock().getTime() - new Date(checkout.dispatched_at).getTime() >= 23 * 3600_000) {
      throw failure('STRIPE_IDEMPOTENCY_WINDOW_EXCEEDED', 409);
    }
    if (!checkout.dispatched_at && new Date(checkout.expires_at).getTime() - this.clock().getTime() < 30 * 60_000) {
      throw failure('STRIPE_PREPARATION_EXPIRED', 409);
    }
    const body = this.persistRequest(checkout);
    this.store.markStripeCheckoutDispatched(checkout.id);
    const session = this.parseSession(checkout.id, await this.request('/checkout/sessions', 'POST', body, checkout.idempotency_key));
    return this.apply(checkout.id, session);
  }

  async webhook(rawBody: Buffer, signatureHeader: string | undefined) {
    this.requireConfig();
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 1_000_000 || !signatureHeader || signatureHeader.length > 10_000) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    const parts = signatureHeader.split(',').map(part => part.trim().split('='));
    const timestamps = parts.filter(([key]) => key === 't').map(([, value]) => value);
    if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0] ?? '')) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    const timestamp = Number(timestamps[0]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(this.clock().getTime() / 1000 - timestamp) > 300) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    const expected = createHmac('sha256', this.options.env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.`).update(rawBody).digest();
    const valid = parts.some(([key, value]) => key === 'v1' && /^[a-fA-F0-9]{64}$/.test(value ?? '') && timingSafeEqual(Buffer.from(value!, 'hex'), expected));
    if (!valid) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    let event: unknown;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw failure('STRIPE_WEBHOOK_INVALID', 400); }
    if (!object(event) || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof event.type !== 'string' || event.livemode !== false ||
      (event.account !== undefined && event.account !== this.options.env.STRIPE_ACCOUNT_ID)) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    if (!CHECKOUT_EVENTS.has(event.type)) return { received: true, handled: false };
    if (!object(event.data) || !object(event.data.object) || typeof event.data.object.id !== 'string' || !/^cs_test_[A-Za-z0-9]+$/.test(event.data.object.id)) throw failure('STRIPE_WEBHOOK_INVALID', 400);
    const eventId = event.id, eventType = event.type, sessionId = event.data.object.id;
    const already = this.store.db.prepare('SELECT checkout_id FROM stripe_checkout_webhook_events WHERE event_id=?').get(eventId);
    if (already) return { received: true, handled: true };
    const metadata = event.data.object.metadata;
    const checkout = this.store.listStripeCheckouts().find(item => item.session_id === sessionId ||
      (object(metadata) && metadata.checkout_id === item.id));
    if (!checkout) return { received: true, handled: false };
    await this.run(checkout.id, async () => {
      await this.verifyAccount();
      const session = this.parseSession(checkout.id, await this.request(`/checkout/sessions/${encodeURIComponent(sessionId)}`));
      if (session.id !== sessionId || checkout.stripe_account_id !== this.options.env.STRIPE_ACCOUNT_ID) {
        this.store.markStripeCheckoutReconciliation(checkout.id, 'STRIPE_SESSION_MISMATCH');
        throw failure('STRIPE_SESSION_MISMATCH', 409);
      }
      // Domain fulfillment is atomic and idempotent. Mark delivery only afterwards;
      // a crash between these steps safely rechecks the same already-paid session.
      let result = this.apply(checkout.id, session);
      if (eventType === 'checkout.session.async_payment_failed' && !['paid', 'expired'].includes(result.state)) {
        result = await this.settleFailure(checkout.id, session, eventId);
      }
      this.store.db.prepare('INSERT OR IGNORE INTO stripe_checkout_webhook_events VALUES(?,?,?,?)').run(eventId, checkout.id, eventType, this.clock().toISOString());
      return result;
    });
    return { received: true, handled: true };
  }

  /** Poll only already-bound sessions; background recovery never creates Checkout Sessions. */
  startBackground(intervalMs = 5000) {
    if (this.timer || this.closed || !this.status().ready || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.polling || this.closed) return;
      const pending = this.store.listStripeCheckouts().filter(checkout => checkout.session_id && !terminal(checkout));
      const batch = pending.length ? Array.from({ length: Math.min(5, pending.length) }, (_, index) => pending[(this.cursor + index) % pending.length]!) : [];
      this.cursor = pending.length ? (this.cursor + batch.length) % pending.length : 0;
      this.polling = (async () => { for (const checkout of batch) if (!this.closed) await this.reconcile(checkout.id).catch(() => undefined); })()
        .finally(() => { this.polling = undefined; });
    }, intervalMs);
    this.timer.unref();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    await Promise.allSettled(this.inFlight.values());
  }
}
