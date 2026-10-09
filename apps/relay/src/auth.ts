import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User } from '@a2a-js/sdk/server';
import type { Config, Identity, RelayOperation } from './config.js';

export class RelayUser implements User {
  constructor(readonly identity: Identity) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.identity.id;
  }
}

/** Constant-time lookup of a bearer token. The sender is always derived from this, never from the body. */
export function identify(cfg: Config, header: string | undefined): Identity | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return undefined;
  const tokenValue = m[1].trim();
  if (cfg.lookupToken) return cfg.lookupToken(tokenValue);
  const given = Buffer.from(tokenValue);
  for (const [token, identity] of cfg.tokens) {
    const expected = Buffer.from(token);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return identity;
  }
  // Tokens issued through enrollment codes are stored only as SHA-256 hashes.
  return cfg.lookupAgentToken?.(m[1].trim()) ?? cfg.lookupIssuedToken?.(hashToken(m[1].trim()));
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

declare module 'express-serve-static-core' {
  interface Request {
    identity?: Identity;
  }
}

export function identityAllowed(cfg: Config, identity: Identity, operation?: RelayOperation): boolean {
  if (cfg.businessId && identity.role === 'business' && identity.business_id !== cfg.businessId) return false;
  return cfg.checkIdentity?.(identity, operation) !== false;
}

export function requireRole(cfg: Config, ...roles: Identity['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    let identity = identify(cfg, req.header('authorization'));
    // Public sandbox sessions carry no account or payment authority. Never let this
    // fallback satisfy a business/admin route or hide an invalid supplied credential.
    if (!identity && !req.header('authorization') && cfg.demoPublicA2a && roles.length === 1 && roles[0] === 'customer') {
      const session = req.header('x-demo-session');
      if (session && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(session)) {
        res.status(400).json({ error: 'X-Demo-Session must be a random UUID v4' });
        return;
      }
      identity = req.identity?.id.startsWith('demo:') ? req.identity : { id: `demo:${session ?? randomUUID()}`, role: 'customer' };
      if (cfg.demoCustomerId) identity = { ...identity, demo: true, customer_id: cfg.demoCustomerId(identity.id.slice(5)) };
      res.set('X-Demo-Session', identity.id.slice(5)).set('Cache-Control', 'no-store');
    }
    if (!identity) {
      const challenge = cfg.authResourceMetadataUrl ? `Bearer resource_metadata="${cfg.authResourceMetadataUrl}"` : 'Bearer';
      res.status(401).set('WWW-Authenticate', challenge).json({ error: 'missing or invalid bearer token' });
      return;
    }
    if (!roles.includes(identity.role)) {
      res.status(403).json({ error: `role ${identity.role} may not call this endpoint` });
      return;
    }
    if (!identityAllowed(cfg, identity)) {
      res.status(403).json({ error: 'connection is no longer authorized' });
      return;
    }
    req.identity = identity;
    next();
  };
}
