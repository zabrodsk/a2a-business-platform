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
  // Keep existing deployments and stored credentials valid under the new product name.
  for (const suffix of ['FRESH', 'OWNER_SETUP_SECRET', 'RELAY_PUBLIC_URL']) {
    if (env[`HANDLE_${suffix}`] !== undefined) configured[`HANDORU_${suffix}`] = env[`HANDLE_${suffix}`];
  }
  // This entry point is the prepared fictional shop. Open proof-of-concept setup
  // is its default; fresh owner-managed installations keep their normal flow.
  if (configured.HANDORU_FRESH === 'true') {
    configured.DEMO_OPEN_BUSINESS = 'false';
  } else {
    configured.DEMO_OPEN_BUSINESS ??= 'true';
    if (configured.DEMO_OPEN_BUSINESS === 'true') {
      configured.DEMO_PUBLIC_A2A ??= 'true';
      configured.DEMO_CHAT_APPROVAL ??= 'true';
    }
  }
  const accessPath = resolve(repoRoot, 'data/legacy-access.json');
  const development = configured.NODE_ENV !== 'production';
  let saved: Record<string, string> = {};
  if (development) {
    if (existsSync(accessPath)) saved = JSON.parse(readFileSync(accessPath, 'utf8')) as Record<string, string>;
    const names = [ 'LEGACY_OWNER_PASSWORD', 'LEGACY_STAFF_PASSWORD', 'LEGACY_CUSTOMER_A_PASSWORD', 'LEGACY_CUSTOMER_B_PASSWORD', 'LEGACY_BUSINESS_AGENT_TOKEN', 'LEGACY_CUSTOMER_AGENT_A_TOKEN', 'LEGACY_CUSTOMER_AGENT_B_TOKEN', 'LEGACY_RELAY_ADMIN_TOKEN', 'LEGACY_OWNER_AGENT_TOKEN'];
    let changed = false;
    for (const name of names) if (!configured[name] && !saved[name]) { saved[name] = randomBytes(24).toString('base64url'); changed = true; }
    if (changed) { mkdirSync(dirname(accessPath), { recursive: true }); writeFileSync(accessPath, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); }
    chmodSync(accessPath, 0o600);
    for (const [key, value] of Object.entries(saved)) if(key!=='HANDORU_OWNER_SETUP_SECRET')configured[key] ??= value;
    const handoruAccessPath=resolve(repoRoot,'data/handoru-access.json');
    if(!configured.HANDORU_OWNER_SETUP_SECRET){
      let ownerAccess:Record<string,string>={};
      if(existsSync(handoruAccessPath))ownerAccess=JSON.parse(readFileSync(handoruAccessPath,'utf8'));
      if(!ownerAccess.HANDORU_OWNER_SETUP_SECRET){ownerAccess.HANDORU_OWNER_SETUP_SECRET=randomBytes(32).toString('base64url');mkdirSync(dirname(handoruAccessPath),{recursive:true});writeFileSync(handoruAccessPath,JSON.stringify(ownerAccess,null,2)+'\n',{mode:0o600});}
      chmodSync(handoruAccessPath,0o600);configured.HANDORU_OWNER_SETUP_SECRET=ownerAccess.HANDORU_OWNER_SETUP_SECRET;
    }
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
    ...(configured.HANDORU_FRESH === 'true' ? [] : [[required('LEGACY_BUSINESS_AGENT_TOKEN'), { id: 'garage-demo', role: 'business_agent' }] as [string, Actor]]),
    [required('LEGACY_CUSTOMER_AGENT_A_TOKEN'), { id: 'customer-agent-a', role: 'customer_agent', customer_id: 'customer-001' }],
    [required('LEGACY_CUSTOMER_AGENT_B_TOKEN'), { id: 'customer-agent-b', role: 'customer_agent', customer_id: 'customer-002' }],
  ]);
  if (tokens.size !== (configured.HANDORU_FRESH === 'true' ? 2 : 3)) throw new Error('Agent credentials must be distinct');
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
