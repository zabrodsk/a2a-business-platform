import { EventEmitter } from 'node:events';
import { identityAllowed } from './auth.js';
import type { Config, Identity } from './config.js';
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

  /** One-time native upgrade: retain a trusted legacy hook under current compatibility authority. */
  migrateCompatibilityWebhook(identity: Identity): boolean {
    if (this.cfg.businessId !== 'pneu007' || this.db.businessId !== 'pneu007'
      || identity.role !== 'business' || identity.business_id !== 'pneu007'
      || identity.connection_id !== 'compatibility-pneu007' || !Number.isSafeInteger(identity.execution_epoch)
      || identity.execution_epoch! < 1 || !this.cfg.checkIdentity) return false;
    try { if (this.cfg.isActive?.() === false) return false; } catch { return false; }
    return this.db.sqlite.transaction(() => {
      // Revalidate inside the synchronous migration transaction; never infer authority from env alone.
      try { if (!identityAllowed(this.cfg, identity, 'doorbell.write')) return false; } catch { return false; }
      const marker = 'compatibility_webhook_migrated:pneu007:v1';
      if (this.db.getSetting(marker)) return false;
      const stored = this.db.getSetting('business_webhook');
      let candidate: { url?: unknown; key?: unknown; identity?: unknown } | undefined;
      try { candidate = stored ? JSON.parse(stored) : this.cfg.businessWebhook; } catch { /* invalid old setting stays disabled */ }
      // Persist the attempt even for an absent/invalid/bound hook. Later env changes are not consent.
      this.db.setSetting(marker, JSON.stringify({ connection_id: identity.connection_id, execution_epoch: identity.execution_epoch }));
      if (!candidate || Object.hasOwn(candidate, 'identity') || typeof candidate.url !== 'string' || typeof candidate.key !== 'string'
        || candidate.key.length < 8 || candidate.key.length > 512 || /[\r\n]/.test(candidate.key)) return false;
      let url: URL;
      try { url = new URL(candidate.url); } catch { return false; }
      const host = url.hostname.toLowerCase();
      const local = host === '127.0.0.1' || host === 'localhost';
      if (url.username || url.password || url.hash || !this.cfg.pushHostAllowlist.includes(host)
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return false;
      this.db.setSetting('business_webhook', JSON.stringify({ url: url.toString(), key: candidate.key, identity }));
      return true;
    }).immediate();
  }

  /** The webhook the Business bot registered itself (`inbox set-doorbell`) wins over env config. */
  webhook(): { url: string; key: string } | undefined {
    const stored = this.db.getSetting('business_webhook');
    if (stored) {
      const hook = JSON.parse(stored) as { url: string; key: string; identity?: Identity };
      if (hook.identity && !identityAllowed(this.cfg, hook.identity, 'doorbell.write')) return undefined;
      // Managed resources may never reuse a webhook lacking its authorizing connection.
      if (this.cfg.businessId && !hook.identity) return undefined;
      return hook;
    }
    return this.cfg.businessId ? undefined : this.cfg.businessWebhook;
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
      await res.body?.cancel();
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_rung', detail: { reason, pending, status: res.status } });
      return { status: res.status };
    } catch (err) {
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_failed', detail: { reason, pending, error: String(err) } });
      return { error: String(err) };
    }
  }
}
