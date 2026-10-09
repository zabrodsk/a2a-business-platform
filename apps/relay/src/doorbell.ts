import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { identityAllowed } from './auth.js';
import type { Config, Identity } from './config.js';
import type { RelayDb } from './db.js';

const VERIFY_SETTING = 'business_webhook_verification';
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_RETRY_MS = 15_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (hook: { url: string; key: string }) => digest(JSON.stringify({ url: hook.url, key: hook.key }));
interface Verification {
  credential_hash: string;
  webhook_fingerprint: string;
  expires_at?: number;
  verified_at?: number;
  last_probe_at?: number;
  probe_hashes: string[];
}
export interface WakeupStatus {
  configured: boolean;
  ready: boolean;
  verification_state: 'unconfigured' | 'unverified' | 'pending' | 'verified' | 'expired';
  webhook_fingerprint?: string;
  host?: string;
  verified_at?: string;
  expires_at?: string;
}

// A doorbell carries no customer text. Setup proves execution with a one-use
// challenge acknowledged by the same business credential that installed it.
export class Doorbell {
  readonly signal = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private lastRingAt = 0;
  private probeInFlight = false;

  constructor(private readonly cfg: Config, private readonly db: RelayDb) {
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
      const hook = JSON.parse(stored) as { url: string; key: string; identity?: Identity } | null;
      if (!hook) return undefined;
      if (hook.identity && !identityAllowed(this.cfg, hook.identity, 'doorbell.write')) return undefined;
      // Managed callbacks remain bound to the authorizing connection and epoch.
      if (this.cfg.businessId && !hook.identity) return undefined;
      return hook;
    }
    return this.cfg.businessId ? undefined : this.cfg.businessWebhook;
  }

  private verification(): Verification | undefined {
    const stored = this.db.getSetting(VERIFY_SETTING);
    return stored ? JSON.parse(stored) : undefined;
  }

  private saveVerification(value: Verification | undefined) {
    this.db.setSetting(VERIFY_SETTING, value ? JSON.stringify(value) : undefined);
  }

  status(credentialHash: string): WakeupStatus {
    const hook = this.webhook();
    if (!hook) return { configured: false, ready: false, verification_state: 'unconfigured' };
    const webhook_fingerprint = fingerprint(hook);
    const base = { configured: true, ready: false, webhook_fingerprint, host: new URL(hook.url).hostname };
    const verification = this.verification();
    if (!verification || verification.credential_hash !== credentialHash || verification.webhook_fingerprint !== webhook_fingerprint) {
      return { ...base, verification_state: 'unverified' };
    }
    if (verification.verified_at) {
      return { ...base, ready: true, verification_state: 'verified', verified_at: new Date(verification.verified_at).toISOString() };
    }
    if (verification.expires_at) {
      return { ...base, verification_state: verification.expires_at > Date.now() ? 'pending' : 'expired', expires_at: new Date(verification.expires_at).toISOString() };
    }
    return { ...base, verification_state: 'unverified' };
  }

  configure(hook: { url: string; key: string; identity?: Identity }, credentialHash: string) {
    const current = this.verification();
    const previous = this.db.getSetting('business_webhook');
    const previousIdentity = previous ? (JSON.parse(previous) as { identity?: Identity } | null)?.identity : undefined;
    this.db.setSetting('business_webhook', JSON.stringify(hook));
    if (current?.credential_hash !== credentialHash || current.webhook_fingerprint !== fingerprint(hook) ||
      JSON.stringify(previousIdentity) !== JSON.stringify(hook.identity)) this.saveVerification(undefined);
  }

  clear() {
    // A persisted tombstone also disables an environment fallback after restart.
    this.db.setSetting('business_webhook', 'null');
    this.saveVerification(undefined);
  }

  /** HTTP success alone cannot establish that the agent executed its routine. */
  async testRing(credentialHash: string): Promise<{ status?: number; error?: string }> {
    const hook = this.webhook();
    if (!hook) return { error: 'no webhook configured' };
    this.saveVerification({ credential_hash: credentialHash, webhook_fingerprint: fingerprint(hook), expires_at: Date.now() + PROBE_TTL_MS, probe_hashes: [] });
    return this.sendProbe();
  }

  acknowledge(probeToken: unknown, credentialHash: string): boolean {
    const hook = this.webhook();
    const verification = this.verification();
    if (typeof probeToken !== 'string' || probeToken.length > 128 || !hook || !verification ||
      verification.credential_hash !== credentialHash || verification.webhook_fingerprint !== fingerprint(hook) ||
      !verification.expires_at || verification.expires_at <= Date.now() || verification.verified_at ||
      !verification.probe_hashes.includes(digest(probeToken))) return false;
    this.saveVerification({ credential_hash: credentialHash, webhook_fingerprint: verification.webhook_fingerprint, verified_at: Date.now(), probe_hashes: [] });
    this.db.logEvent({ actor: 'relay', kind: 'doorbell_verified', detail: { host: new URL(hook.url).hostname } });
    return true;
  }

  ring(reason: string) {
    this.signal.emit('work');
    if (Date.now() - this.lastRingAt < 3000) return;
    this.lastRingAt = Date.now();
    void this.post(reason);
  }

  startReringLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const verification = this.verification();
      if (verification?.expires_at && verification.expires_at > Date.now() && !verification.verified_at &&
        Date.now() - (verification.last_probe_at ?? 0) >= PROBE_RETRY_MS) void this.sendProbe();
      const stale = this.db.itemsToRering(this.cfg.reringMs);
      if (stale.length) {
        this.db.markRung(stale.map((i) => i.id));
        void this.post('rering');
      }
    }, Math.min(this.cfg.reringMs, PROBE_RETRY_MS));
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sendProbe(): Promise<{ status?: number; error?: string }> {
    if (this.probeInFlight) return { error: 'verification probe already in progress' };
    const hook = this.webhook();
    const verification = this.verification();
    if (!hook || !verification?.expires_at || verification.expires_at <= Date.now() || verification.verified_at ||
      verification.webhook_fingerprint !== fingerprint(hook)) return { error: 'verification is not pending' };
    const token = randomBytes(32).toString('base64url');
    verification.probe_hashes = [...verification.probe_hashes, digest(token)].slice(-24);
    verification.last_probe_at = Date.now();
    this.saveVerification(verification);
    this.probeInFlight = true;
    try {
      return await this.post('test', { token, expires_at: new Date(verification.expires_at).toISOString() });
    } finally {
      this.probeInFlight = false;
    }
  }

  private rearmAfterFailure(hook: { url: string; key: string }, expectedVerification: string | undefined) {
    const currentHook = this.webhook();
    // A delayed provider failure must never overwrite a replacement callback or
    // a newer verification attempt completed while this delivery was in flight.
    if (!currentHook || !expectedVerification || this.db.getSetting(VERIFY_SETTING) !== expectedVerification ||
      fingerprint(currentHook) !== fingerprint(hook)) return;
    const verification = JSON.parse(expectedVerification) as Verification;
    if (!verification.verified_at || verification.webhook_fingerprint !== fingerprint(hook)) return;
    this.saveVerification({ credential_hash: verification.credential_hash,
      webhook_fingerprint: verification.webhook_fingerprint, expires_at: Date.now() + PROBE_TTL_MS,
      last_probe_at: Date.now(), probe_hashes: [] });
  }

  private async post(reason: string, setup_probe?: { token: string; expires_at: string }): Promise<{ status?: number; error?: string }> {
    const hook = this.webhook();
    const pending = this.db.countAvailable(this.cfg.leaseMs);
    if (!hook) {
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_skipped', detail: { reason, pending, why: 'no webhook configured' } });
      return { error: 'no webhook configured' };
    }
    const expectedVerification = this.db.getSetting(VERIFY_SETTING);
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${hook.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'work_pending', pending, reason, ...(setup_probe ? { setup_probe } : {}) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      // Provider bodies may echo authorization or probe secrets. Never record them.
      await res.body?.cancel();
      if (!res.ok) this.rearmAfterFailure(hook, expectedVerification);
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_rung', detail: { reason, pending, status: res.status } });
      return { status: res.status };
    } catch {
      this.rearmAfterFailure(hook, expectedVerification);
      const error = 'webhook request failed';
      this.db.logEvent({ actor: 'relay', kind: 'doorbell_failed', detail: { reason, pending, error } });
      return { error };
    }
  }
}
