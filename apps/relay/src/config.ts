// Relay configuration. Managed authority is resolved live for every request.
import type { Message, TaskState } from '@a2a-js/sdk';

export interface Identity {
  id: string;
  role: 'customer' | 'business' | 'admin' | 'unclaimed';
  /** Server-verified local account binding, never taken from an A2A message. */
  customer_id?: string;
  business_id?: string;
  connection_id?: string;
  execution_epoch?: number;
  scopes?: string[];
  demo?: boolean;
}

export type RelayOperation = 'inbox.read' | 'inbox.reply' | 'doorbell.write' | 'tasks.read' | 'a2a';

/** Durable acceptance record; the platform may store it in its authority DB before relay delivery. */
export interface AcceptedReply {
  work_item_id: string;
  task_id: string;
  context_id: string;
  owner: string;
  business_id: string;
  connection_id?: string;
  execution_epoch?: number;
  message_id: string;
  reply: { state: TaskState; message?: Message };
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
  /** Credentials managed by the business adapter, shared by tools and A2A. */
  lookupAgentToken?: (token: string) => Identity | undefined;
  authResourceMetadataUrl?: string;
  /** Explicit sandbox opt-in: unauthenticated A2A conversations, never business tools. */
  demoPublicA2a?: boolean;
  demoChatApproval?: boolean;
  demoOpenBusiness?: boolean;
  /** The open demo facade must never claim historical/account-linked customer work. */
  demoOnlyOwners?: boolean;
  demoCustomerId?: (session: string) => string;
  /** One isolated transport DB per managed resource. Absent for the legacy standalone relay. */
  businessId?: string;
  /** Authoritative resolver: when supplied no environment/enrollment token fallback is permitted. */
  lookupToken?: (token: string) => Identity | undefined;
  checkIdentity?: (identity: Identity, operation?: RelayOperation) => boolean;
  isActive?: () => boolean;
  /** Synchronous acceptance, without an await between authority check and durable commit. */
  acceptReply?: (record: AcceptedReply, identity: Identity) => AcceptedReply;
  pendingReplies?: () => AcceptedReply[];
  markReplyDelivered?: (workItemId: string) => void;
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
  if ((env.HANDLE_FRESH ?? env.HANDORU_FRESH) !== 'true' && ![...tokens.values()].some((i) => i.role === 'business')) {
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
    demoPublicA2a: env.DEMO_PUBLIC_A2A === 'true',
  };
}
