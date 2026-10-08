import { randomBytes } from 'node:crypto';
import express, { type Router } from 'express';
import { hashToken, requireRole } from './auth.js';
import type { Config, Identity } from './config.js';
import type { RelayDb } from './db.js';

// One-time enrollment codes, so a bot's token never has to be pasted into a chat.
// The admin creates a short-lived code; the bot redeems it once from its own terminal and
// gets a fresh token that is written straight to its config file. Only the (burnt) code
// ever appears in chat. The relay stores hashes only.

const ROLES: Identity['role'][] = ['customer', 'business'];

export function enrollRouter(cfg: Config, db: RelayDb): Router {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));

  // POST /admin/enrollments {"role":"business","id":"garage-demo","ttl_minutes":60}
  r.post('/admin/enrollments', requireRole(cfg, 'admin'), (req, res) => {
    const role = req.body?.role as Identity['role'];
    if (!ROLES.includes(role)) return void res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    const id = String(req.body?.id ?? (role === 'business' ? 'garage-demo' : 'customer-a'));
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return void res.status(400).json({ error: 'id must match [a-z0-9-]{1,40}' });
    const ttl = Math.min(Math.max(Number(req.body?.ttl_minutes ?? 60), 1), 24 * 60);
    const code = randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + ttl * 60_000;
    db.createEnrollment(hashToken(code), id, role, expiresAt);
    db.logEvent({ actor: 'admin', kind: 'enrollment_created', detail: { id, role, expires_at: new Date(expiresAt).toISOString() } });
    res.json({ redeem_url: `${cfg.publicUrl}/enroll/${code}`, id, role, expires_at: new Date(expiresAt).toISOString() });
  });

  // POST /enroll/<code>: redeem once, receive a new bearer token.
  r.post('/enroll/:code', (req, res) => {
    const token = randomBytes(24).toString('hex');
    const row = db.redeemEnrollment(hashToken(req.params.code), hashToken(token));
    if (!row) {
      db.logEvent({ actor: 'anonymous', kind: 'enrollment_rejected' });
      return void res.status(404).json({ error: 'enrollment code is unknown, expired, or already used' });
    }
    db.logEvent({ actor: row.identity_id, kind: 'enrollment_redeemed', detail: { role: row.role } });
    res.json({ url: cfg.publicUrl, token, id: row.identity_id, role: row.role });
  });

  return r;
}
