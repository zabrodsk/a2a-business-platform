import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User } from '@a2a-js/sdk/server';
import type { Config, Identity } from './config.js';

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
  const given = Buffer.from(m[1].trim());
  for (const [token, identity] of cfg.tokens) {
    const expected = Buffer.from(token);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return identity;
  }
  // Tokens issued through enrollment codes are stored only as SHA-256 hashes.
  return cfg.lookupIssuedToken?.(hashToken(m[1].trim()));
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

declare module 'express-serve-static-core' {
  interface Request {
    identity?: Identity;
  }
}

export function requireRole(cfg: Config, ...roles: Identity['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const identity = identify(cfg, req.header('authorization'));
    if (!identity) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'missing or invalid bearer token' });
      return;
    }
    if (!roles.includes(identity.role)) {
      res.status(403).json({ error: `role ${identity.role} may not call this endpoint` });
      return;
    }
    req.identity = identity;
    next();
  };
}
