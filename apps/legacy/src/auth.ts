import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import { BusinessError, type Actor, type ActorRole } from '../../../packages/contracts/index.js';

export interface HumanUser { username: string; password: string; actor: Actor }
export interface AuthOptions {
  users: HumanUser[];
  agentTokens: Map<string, Actor>;
  lookupAgentToken?: (token: string) => Actor | undefined;
  secureCookies?: boolean;
  publicOrigin?: string;
  now?: () => Date;
}
declare module 'express-serve-static-core' { interface Request { legacyActor?: Actor; legacySession?: Session } }
interface Session { token_hash: string; actor_json: string; csrf: string; expires_at: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const forbidden = (message: string): never => { throw new BusinessError('FORBIDDEN', message, 403); };

/** Bearer identities are bots; only password-authenticated browser sessions represent humans. */
export class LegacyAuth {
  private readonly now: () => Date;
  private readonly failures = new Map<string, { count: number; reset: number }>();
  private readonly ipAttempts = new Map<string, { count: number; reset: number }>();
  private globalAttempts = { count: 0, reset: 0 };
  constructor(readonly db: Database.Database, readonly options: AuthOptions) {
    this.now = options.now ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS legacy_users(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL, actor_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_sessions(token_hash TEXT PRIMARY KEY, actor_json TEXT NOT NULL, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);`);
    for (const user of options.users) {
      if (!user.password || user.password.length < 12) throw new Error(`Password required for ${user.username} (at least 12 characters)`);
      if (!['owner', 'staff', 'human_customer'].includes(user.actor.role)) throw new Error('Human users cannot have agent roles');
      const salt = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO legacy_users VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,salt=excluded.salt,actor_json=excluded.actor_json')
        .run(user.username, scryptSync(user.password, salt, 64).toString('hex'), salt, JSON.stringify(user.actor));
    }
    for (const [token, actor] of options.agentTokens) {
      if (token.length < 24 || !['business_agent', 'customer_agent', 'owner_agent'].includes(actor.role)) throw new Error('Agent tokens must be distinct strong credentials with agent-only roles');
    }
  }
  identify(req: Request): Actor | undefined {
    const header = req.header('authorization');
    if (header) {
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) return undefined;
      for (const [configured, actor] of this.options.agentTokens) if (same(token, configured)) return actor;
      return this.options.lookupAgentToken?.(token);
    }
    const cookie = req.header('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('pneu007_session='))?.slice('pneu007_session='.length);
    if (!cookie || cookie.length > 200) return undefined;
    const session = this.db.prepare('SELECT * FROM legacy_sessions WHERE token_hash=? AND expires_at>?').get(digest(cookie), this.now().toISOString()) as Session | undefined;
    if (!session) return undefined;
    req.legacySession = session;
    return JSON.parse(session.actor_json) as Actor;
  }
  middleware = (req: Request, _res: Response, next: NextFunction) => { req.legacyActor = this.identify(req); next(); };
  require(...roles: ActorRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.legacyActor) {
        const resourceMetadata = `${this.options.publicOrigin ?? ''}/.well-known/oauth-protected-resource`;
        res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`);
        return next(new BusinessError('UNAUTHENTICATED', 'Přihlaste se nebo použijte vlastní agentí token.', 401));
      }
      if (!roles.includes(req.legacyActor.role)) return next(new BusinessError('FORBIDDEN', 'Tato identita nemá oprávnění k operaci.', 403));
      next();
    };
  }
  checkOrigin(req: Request) {
    const origin = req.header('origin');
    if (origin && this.options.publicOrigin && origin !== this.options.publicOrigin) forbidden('Foreign origin is not permitted');
    if (origin && !this.options.publicOrigin && origin !== `${req.protocol}://${req.get('host')}`) forbidden('Foreign origin is not permitted');
  }
  protect = (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        this.checkOrigin(req);
        if (req.path !== '/login' && req.legacySession && !same(req.header('x-csrf-token') ?? '', req.legacySession.csrf)) forbidden('Missing or invalid session CSRF token');
      }
      next();
    } catch (error) { next(error); }
  };
  login(req: Request, res: Response) {
    this.checkOrigin(req);
    const now = this.now().getTime(), ip = req.ip ?? 'unknown';
    for (const [key, value] of this.failures) if (value.reset <= now) this.failures.delete(key);
    for (const [key, value] of this.ipAttempts) if (value.reset <= now) this.ipAttempts.delete(key);
    if (this.globalAttempts.reset <= now) this.globalAttempts = { count: 0, reset: now + 60_000 };
    const attempts = this.ipAttempts.get(ip) ?? { count: 0, reset: now + 15 * 60_000 };
    if (attempts.count >= 30 || this.globalAttempts.count >= 150 || this.ipAttempts.size >= 1024 || this.failures.size >= 2048) {
      throw new BusinessError('LOGIN_RATE_LIMIT', 'Příliš mnoho pokusů. Zkuste to později.', 429);
    }
    attempts.count += 1; this.globalAttempts.count += 1; this.ipAttempts.set(ip, attempts);
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) throw new BusinessError('INVALID_LOGIN', 'Neplatné přihlašovací údaje.', 400);
    const bucketKey = `${ip}:${username}`;
    const bucket = this.failures.get(bucketKey);
    if (bucket && bucket.reset > now && bucket.count >= 10) throw new BusinessError('LOGIN_RATE_LIMIT', 'Příliš mnoho pokusů. Zkuste to později.', 429);
    const user = this.db.prepare('SELECT * FROM legacy_users WHERE username=?').get(username) as { password_hash: string; salt: string; actor_json: string } | undefined;
    const salt = user?.salt ?? 'missing-user-fixed-timing-salt';
    const calculated = scryptSync(password, salt, 64).toString('hex');
    if (!user || !same(calculated, user.password_hash)) {
      this.failures.set(bucketKey, { count: bucket && bucket.reset > now ? bucket.count + 1 : 1, reset: now + 15 * 60_000 });
      throw new BusinessError('INVALID_LOGIN', 'Neplatné přihlašovací údaje.', 401);
    }
    this.failures.delete(bucketKey);
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    const expires = new Date(now + 12 * 60 * 60_000).toISOString();
    this.db.prepare('INSERT INTO legacy_sessions VALUES(?,?,?,?)').run(digest(token), user.actor_json, csrf, expires);
    res.cookie('pneu007_session', token, { httpOnly: true, secure: this.options.secureCookies ?? false, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60_000 });
    return { actor: JSON.parse(user.actor_json) as Actor, csrf_token: csrf };
  }
  logout(req: Request, res: Response) {
    if (req.legacySession) this.db.prepare('DELETE FROM legacy_sessions WHERE token_hash=?').run(req.legacySession.token_hash);
    res.clearCookie('pneu007_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: this.options.secureCookies ?? false });
  }
}
