import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../../../packages/contracts/index.js';
import type { AuthOptions } from './auth.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export interface LegacyConfig {
  dbPath: string;
  host: string;
  port: number;
  publicUrl: string;
  auth: AuthOptions;
  env: NodeJS.ProcessEnv;
  reconciliationMs: number;
}
export function loadLegacyConfig(env: NodeJS.ProcessEnv = process.env): LegacyConfig {
  const configured = { ...env };
  const accessPath = resolve(repoRoot, 'data/legacy-access.json');
  const development = configured.NODE_ENV !== 'production';
  let saved: Record<string, string> = {};
  if (development) {
    if (existsSync(accessPath)) saved = JSON.parse(readFileSync(accessPath, 'utf8')) as Record<string, string>;
    const names = ['LEGACY_OWNER_PASSWORD', 'LEGACY_STAFF_PASSWORD', 'LEGACY_CUSTOMER_A_PASSWORD', 'LEGACY_CUSTOMER_B_PASSWORD', 'LEGACY_BUSINESS_AGENT_TOKEN', 'LEGACY_CUSTOMER_AGENT_A_TOKEN', 'LEGACY_CUSTOMER_AGENT_B_TOKEN', 'LEGACY_RELAY_ADMIN_TOKEN', 'LEGACY_OWNER_AGENT_TOKEN'];
    let changed = false;
    for (const name of names) if (!configured[name] && !saved[name]) { saved[name] = randomBytes(24).toString('base64url'); changed = true; }
    if (changed) { mkdirSync(dirname(accessPath), { recursive: true }); writeFileSync(accessPath, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); }
    chmodSync(accessPath, 0o600);
    for (const [key, value] of Object.entries(saved)) configured[key] ??= value;
  }
  const required = (key: string) => {
    const value = configured[key];
    if (!value || value.length < 12) throw new Error(`${key} is required; credentials are never placed in public files`);
    return value;
  };
  const port = Number(configured.LEGACY_PORT ?? configured.PORT ?? 8797);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid LEGACY_PORT');
  const publicUrl = (configured.LEGACY_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const publicOrigin = new URL(publicUrl).origin;
  const tokens = new Map<string, Actor>([
    [required('LEGACY_BUSINESS_AGENT_TOKEN'), { id: 'garage-demo', role: 'business_agent' }],
    [required('LEGACY_CUSTOMER_AGENT_A_TOKEN'), { id: 'customer-agent-a', role: 'customer_agent', customer_id: 'customer-001' }],
    [required('LEGACY_CUSTOMER_AGENT_B_TOKEN'), { id: 'customer-agent-b', role: 'customer_agent', customer_id: 'customer-002' }],
  ]);
  if (tokens.size !== 3) throw new Error('Agent credentials must be distinct');
  if (configured.LEGACY_OWNER_AGENT_TOKEN) {
    if (tokens.has(configured.LEGACY_OWNER_AGENT_TOKEN)) throw new Error('Internal owner token must be distinct');
    tokens.set(configured.LEGACY_OWNER_AGENT_TOKEN, { id: 'owner-internal-agent', role: 'owner_agent' });
  }
  required('LEGACY_RELAY_ADMIN_TOKEN');
  return {
    dbPath: configured.LEGACY_DB_PATH ?? resolve(repoRoot, 'data/legacy.db'), host: configured.LEGACY_HOST ?? (development ? '127.0.0.1' : '0.0.0.0'), port, publicUrl,
    auth: { users: [
      { username: 'owner', password: required('LEGACY_OWNER_PASSWORD'), actor: { id: 'staff-owner', role: 'owner' } },
      { username: 'staff', password: required('LEGACY_STAFF_PASSWORD'), actor: { id: 'staff-manager', role: 'staff' } },
      { username: 'customer-a', password: required('LEGACY_CUSTOMER_A_PASSWORD'), actor: { id: 'human-customer-a', role: 'human_customer', customer_id: 'customer-001' } },
      { username: 'customer-b', password: required('LEGACY_CUSTOMER_B_PASSWORD'), actor: { id: 'human-customer-b', role: 'human_customer', customer_id: 'customer-002' } },
    ], agentTokens: tokens, secureCookies: publicOrigin.startsWith('https:'), publicOrigin },
    env: configured, reconciliationMs: Number(configured.LEGACY_RECONCILIATION_MS ?? 5000),
  };
}
