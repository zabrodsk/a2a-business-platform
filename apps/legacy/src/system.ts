import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentCard } from '@a2a-js/sdk';
import { buildAgentCard } from '../../relay/src/card.js';
import type { Config, Identity } from '../../relay/src/config.js';
import { requireRole } from '../../relay/src/auth.js';
import { createRelay } from '../../relay/src/server.js';
import { BusinessError } from '../../../packages/contracts/index.js';
import { loadLegacyConfig, type LegacyConfig } from './config.js';
import { createLegacy } from './server.js';

const run = promisify(execFile);
type LegacyOptions = NonNullable<Parameters<typeof createLegacy>[1]>;

/** Shared credentials bind transport messages and business tools to the same principals. */
export function unifiedRelayConfig(cfg: LegacyConfig): Config {
  const tokens = new Map<string, Identity>();
  for (const [token, actor] of cfg.auth.agentTokens) {
    if (actor.role === 'business_agent' || actor.role === 'customer_agent') {
      tokens.set(token, { id: actor.id, role: actor.role === 'business_agent' ? 'business' : 'customer',
        ...(actor.customer_id ? { customer_id: actor.customer_id } : {}) });
    }
  }
  if ([...tokens.values()].filter(actor => actor.role === 'business').length !== 1) {
    throw new Error('Unified system requires exactly one business-agent identity');
  }
  const adminToken = cfg.env.LEGACY_RELAY_ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 24 || tokens.has(adminToken)) {
    throw new Error('LEGACY_RELAY_ADMIN_TOKEN must be a distinct credential of at least 24 characters');
  }
  tokens.set(adminToken, { id: 'relay-admin', role: 'admin' });
  const dbPath = cfg.env.LEGACY_RELAY_DB_PATH ?? resolve(dirname(cfg.dbPath), 'legacy-relay.db');
  if (dbPath === ':memory:' || resolve(dbPath) === resolve(cfg.dbPath)) {
    throw new Error('Unified relay requires its own persistent SQLite database');
  }
  const integer = (name: string, fallback: number): number => {
    const value = Number(cfg.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  const webhookUrl = cfg.env.LEGACY_BUSINESS_WEBHOOK_URL;
  const webhookKey = cfg.env.LEGACY_BUSINESS_WEBHOOK_KEY;
  if (Boolean(webhookUrl) !== Boolean(webhookKey)) throw new Error('Business webhook URL and key must be configured together');
  return {
    port: cfg.port, publicUrl: cfg.publicUrl, a2aPath: '/a2a/jsonrpc',
    authResourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource`,
    a2aEndpointUrl: `${cfg.publicUrl}/a2a/jsonrpc`, dbPath, tokens,
    businessProfile: 'pneu007',
    businessWebhook: webhookUrl && webhookKey ? { url: webhookUrl, key: webhookKey } : undefined,
    pushHostAllowlist: (cfg.env.LEGACY_PUSH_HOST_ALLOWLIST ?? 'api2.cursor.sh')
      .split(',').map(host => host.trim().toLowerCase()).filter(Boolean),
    replyWaitMs: integer('LEGACY_RELAY_REPLY_WAIT_MS', 15 * 60_000),
    maxAgentTurns: integer('LEGACY_RELAY_MAX_AGENT_TURNS', 10),
    leaseMs: integer('LEGACY_RELAY_LEASE_MS', 5 * 60_000),
    reringMs: integer('LEGACY_RELAY_RERING_MS', 60_000),
  };
}

/** Use the installed SDK's migration CLI, with arguments rather than shell interpolation. */
async function migrateRelayDatabase(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const sdkDist = dirname(fileURLToPath(import.meta.resolve('@a2a-js/sdk')));
  await run(process.execPath, [resolve(sdkDist, 'cli/a2a_db.js'), 'upgrade', '--url', `sqlite:${path}`], {
    timeout: 30_000, maxBuffer: 1024 * 1024,
  });
}

/** Genuine A2A transport plus legacy HTTP tools, without supplying any simulated bot responses. */
export async function createUnifiedSystem(cfg: LegacyConfig, options: Omit<LegacyOptions, 'agentCard' | 'validateRelayTask'> = {}) {
  const relayConfig = unifiedRelayConfig(cfg);
  await migrateRelayDatabase(relayConfig.dbPath);
  const relay = createRelay(relayConfig);
  let legacy: ReturnType<typeof createLegacy>;
  try {
    legacy = createLegacy(cfg, {
      ...options,
      agentCard: () => AgentCard.toJSON(buildAgentCard(relayConfig)),
      validateRelayTask: async (actor, taskId) => {
        if (actor.role !== 'customer_agent' || typeof taskId !== 'string') return false;
        const row = relay.db.sqlite.prepare('SELECT owner FROM work_items WHERE task_id = ? LIMIT 1')
          .get(taskId) as { owner: string } | undefined;
        return row?.owner === actor.id;
      },
    });
  } catch (error) {
    await relay.close();
    throw error;
  }
  relayConfig.lookupAgentToken = token => {
    const actor = legacy.agentAuth.identify(token);
    if (!actor) return undefined;
    return { id: actor.id, role: actor.role === 'customer_agent' ? 'customer' : 'unclaimed',
      ...(actor.customer_id ? { customer_id: actor.customer_id } : {}) };
  };

  // Authenticate before the policy gate, so unpublished operation does not reveal private policy.
  legacy.app.use(relayConfig.a2aPath, requireRole(relayConfig, 'customer'), (_req, res, next) => {
    try { legacy.policy.rulebooks.getActive(); next(); }
    catch (error) {
      if (error instanceof BusinessError) {
        res.status(503).json({ error: error.code, message: 'Business agent is not available until the owner approves a current rulebook.' });
        return;
      }
      next(error);
    }
  });
  // Relay-only enrollment creates credentials unknown to the legacy tool identity registry.
  legacy.app.use(['/admin/enrollments', '/enroll'], (_req, res) => {
    res.status(404).json({ error: 'ENROLLMENT_DISABLED', message: 'Use the shared legacy agent credentials for this unified demo.' });
  });
  legacy.app.use(relay.app);

  let closed = false;
  return {
    ...legacy, relay, relayConfig,
    close: async () => {
      if (closed) return;
      closed = true;
      await relay.close();
      await legacy.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadLegacyConfig();
  const system = await createUnifiedSystem(cfg);
  const server = system.app.listen(cfg.port, cfg.host, (error?: Error) => {
    if (error) {
      console.error(`Unable to start Pneu 007: ${error.message}`);
      void system.close()
        .catch(closeError => { console.error(`Unable to close Pneu 007: ${String(closeError)}`); })
        .finally(() => { process.exitCode = 1; });
      return;
    }
    console.log(`Pneu 007 web, legacy tools and A2A relay: ${cfg.publicUrl}`);
    console.log('Agent Card becomes available after owner activation of an audited rulebook.');
  });
  const stop = () => {
    server.close(() => { void system.close().then(() => { process.exitCode = 0; }); });
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
