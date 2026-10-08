import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import type { RelayDb } from './db.js';

// Wakes the Business GrokBot. The body never carries customer text or secrets:
// the bot is expected to call `inbox read` (scope-of-work: webhook as a doorbell).
export class Doorbell {
  /** In-process signal for `/bot/wait` long-polls. */
  readonly signal = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private lastRingAt = 0;

  constructor(
    private readonly cfg: Config,
    private readonly db: RelayDb,
  ) {
    this.signal.setMaxListeners(100);
  }

  /** The webhook the Business bot registered itself (`inbox set-doorbell`) wins over env config. */
  webhook(): { url: string; key: string } | undefined {
    const stored = this.db.getSetting('business_webhook');
    return stored ? JSON.parse(stored) : this.cfg.businessWebhook;
  }

  /** Rings once right now and reports the HTTP status (used to verify a newly registered webhook). */
  async testRing(): Promise<{ status?: number; error?: string }> {
    return this.post('test');
  }

  /** Notify long-pollers immediately; ring the webhook (debounced to one call per 3 s). */
  ring(reason: string) {
    this.signal.emit('work');
    const since = Date.now() - this.lastRingAt;
    if (since < 3000) return;
    this.lastRingAt = Date.now();
    void this.post(reason);
  }

  startReringLoop() {
    this.timer = setInterval(() => {
      const stale = this.db.itemsToRering(this.cfg.reringMs);
      if (stale.length) {
        this.db.markRung(stale.map((i) => i.id));
        void this.post('rering');
      }
    }, Math.min(this.cfg.reringMs, 15_000));
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async post(reason: string): Promise<{ status?: number; error?: string }> {
    const hook = this.webhook();
    const pending = this.db.countAvailable(this.cfg.leaseMs);
    if (!hook) {
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_skipped', detail: { reason, pending, why: 'no webhook configured' } });
      return { error: 'no webhook configured' };
    }
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${hook.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'work_pending', pending, reason }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.text()).slice(0, 300);
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_rung', detail: { reason, pending, status: res.status, body } });
      return { status: res.status };
    } catch (err) {
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_failed', detail: { reason, pending, error: String(err) } });
      return { error: String(err) };
    }
  }
}
