// Relay configuration, read once from the environment. Secrets live only here.

export interface Identity {
  id: string;
  role: 'customer' | 'business' | 'admin';
}

export interface Config {
  port: number;
  publicUrl: string;
  /** Full URL advertised in the Agent Card. Change it to run the endpoint-move test (T15). */
  a2aEndpointUrl: string;
  /** Path the JSON-RPC handler is mounted on locally. */
  a2aPath: string;
  dbPath: string;
  tokens: Map<string, Identity>;
  businessWebhook?: { url: string; key: string };
  /** Hosts that clients may register as A2A push-notification targets. */
  pushHostAllowlist: string[];
  replyWaitMs: number;
  maxAgentTurns: number;
  leaseMs: number;
  reringMs: number;
  /** Which profiles/<id>.json describes the business on the public card. */
  businessProfile: string;
  /** Set at runtime by the relay: resolves tokens issued via enrollment codes (by SHA-256 hash). */
  lookupIssuedToken?: (tokenHash: string) => Identity | undefined;
}

function parseTokens(env: NodeJS.ProcessEnv): Map<string, Identity> {
  const tokens = new Map<string, Identity>();
  const add = (token: string | undefined, identity: Identity) => {
    if (!token) return;
    if (token.length < 16) throw new Error(`Token for ${identity.id} is shorter than 16 characters`);
    if (tokens.has(token)) throw new Error(`Duplicate token for ${identity.id}`);
    tokens.set(token, identity);
  };
  // CUSTOMER_TOKENS="customer-a:<token>,customer-b:<token>"
  for (const entry of (env.CUSTOMER_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new Error('CUSTOMER_TOKENS entries must look like <id>:<token>');
    add(entry.slice(idx + 1), { id: entry.slice(0, idx), role: 'customer' });
  }
  add(env.BUSINESS_TOKEN, { id: env.BUSINESS_ID ?? 'garage-demo', role: 'business' });
  add(env.ADMIN_TOKEN, { id: 'admin', role: 'admin' });
  return tokens;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const a2aPath = env.A2A_PATH ?? '/a2a/jsonrpc';
  const tokens = parseTokens(env);
  if (![...tokens.values()].some((i) => i.role === 'business')) {
    throw new Error('BUSINESS_TOKEN is required');
  }
  const webhookUrl = env.BUSINESS_WEBHOOK_URL;
  const webhookKey = env.BUSINESS_WEBHOOK_KEY;
  return {
    port,
    publicUrl,
    a2aPath,
    a2aEndpointUrl: env.A2A_ENDPOINT_URL ?? `${publicUrl}${a2aPath}`,
    dbPath: env.DB_PATH ?? 'data/relay.db',
    tokens,
    businessWebhook: webhookUrl && webhookKey ? { url: webhookUrl, key: webhookKey } : undefined,
    pushHostAllowlist: (env.PUSH_HOST_ALLOWLIST ?? 'api2.cursor.sh')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    replyWaitMs: Number(env.REPLY_WAIT_MS ?? 15 * 60_000),
    maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 10),
    leaseMs: Number(env.LEASE_MS ?? 5 * 60_000),
    reringMs: Number(env.RERING_MS ?? 60_000),
    businessProfile: env.BUSINESS_PROFILE ?? 'pneu007',
  };
}
