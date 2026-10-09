import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { AGENT_CARD_PATH, AgentCard } from '@a2a-js/sdk';
import { DefaultExecutionEventBusManager, DefaultPushNotificationSender } from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { DatabasePushNotificationStore, DatabaseTaskStore } from '@a2a-js/sdk/server/database';
import { identify, RelayUser } from './auth.js';
import { requireRole } from './auth.js';
import { botRouter } from './bot-api.js';
import { enrollRouter } from './enroll.js';
import { buildAgentCard, loadProfile } from './card.js';
import { agentLinks, renderHomePage, renderLlmsTxt } from './site.js';
import { loadConfig, type Config } from './config.js';
import { RelayDb } from './db.js';
import { Doorbell } from './doorbell.js';
import { RelayExecutor } from './executor.js';
import { RelayRequestHandler } from './handler.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_DIST = join(here, '../../../packages/agent-client/dist');

export function createRelay(cfg: Config) {
  const db = new RelayDb(cfg.dbPath, cfg.businessId);
  db.assertA2aTables();
  cfg.lookupIssuedToken = (hash) => {
    const row = db.lookupIssuedToken(hash);
    return row ? { id: row.identity_id, role: row.role as 'customer' | 'business' } : undefined;
  };
  const taskStore = new DatabaseTaskStore(db.kysely);
  const pushStore = new DatabasePushNotificationStore(db.kysely);
  const pushSender = new DefaultPushNotificationSender(pushStore);
  const doorbell = new Doorbell(cfg, db);
  const executor = new RelayExecutor(cfg, db, doorbell, taskStore, pushSender);
  // SDK event processing and recovery share the same durable acceptance overlay.
  const saveTask = taskStore.save.bind(taskStore);
  taskStore.save = async (task, context) => {
    const incomingMessageId = task.status?.message?.messageId;
    executor.overlayAcceptedReplies(task);
    await saveTask(task, context);
    // An initial WORKING save may be overlaid while later events are still queued.
    // Only acknowledge an event that already carried the accepted reply before the overlay.
    executor.markPersistedReplies(task, incomingMessageId);
  };
  const card = buildAgentCard(cfg);
  const requestHandler = new RelayRequestHandler(
    card,
    taskStore,
    executor,
    new DefaultExecutionEventBusManager(),
    pushStore,
    pushSender,
  );
  requestHandler.cfg = cfg;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  // The business's public website: every page tells visiting agents where the Agent Card is.
  const profile = loadProfile(cfg.businessProfile);
  const homeHtml = renderHomePage(cfg, profile);
  const llmsTxt = renderLlmsTxt(cfg, profile);
  const { linkHeader } = agentLinks(cfg);
  app.get('/', (_req, res) => {
    if (cfg.isActive?.() === false) return void res.status(404).end();
    res.set('Link', linkHeader).type('html').send(homeHtml);
  });
  app.get('/llms.txt', (_req, res) => {
    if (cfg.isActive?.() === false) return void res.status(404).end();
    res.set('Link', linkHeader).type('text/markdown').send(llmsTxt);
  });
  // Served as ProtoJSON via AgentCard.toJSON: the SDK's agentCardHandler JSON.stringifies the
  // internal object, which leaks `$case` wrappers for oneof fields such as securitySchemes.
  const cardJson = AgentCard.toJSON(card);
  app.get(`/${AGENT_CARD_PATH}`, (_req, res) => {
    if (cfg.isActive?.() === false) return void res.status(404).json({ error: 'business relay is not active' });
    res.set('Cache-Control', 'public, max-age=30').json(cardJson);
  });

  // Public A2A endpoint (JSON-RPC binding). Customers only; identity comes from the bearer token.
  app.use(
    cfg.a2aPath,
    (_req, res, next) => {
      if (cfg.isActive?.() === false) return void res.status(409).json({ error: 'business relay is not active' });
      next();
    },
    requireRole(cfg, 'customer'),
    jsonRpcHandler({
      requestHandler,
      userBuilder: async (req) => new RelayUser(identify(cfg, req.header('authorization'))!),
    }),
  );

  // Private inbox for the Business GrokBot (not A2A).
  app.use('/bot', botRouter(cfg, db, doorbell, executor));

  // One-time enrollment codes (admin creates, bot redeems from its terminal).
  app.use(enrollRouter(cfg, db));

  // Timeline for the console and docs/runtime-proof.md.
  app.get('/admin/events', requireRole(cfg, 'admin'), (req, res) => {
    res.json({
      events: db.listEvents({
        taskId: typeof req.query.task === 'string' ? req.query.task : undefined,
        afterId: Number(req.query.after ?? 0),
      }),
    });
  });

  // Single-file CLIs, so a bot can (re)install them with one curl after a VM reset.
  app.get('/cli/:name', (req, res) => {
    const file = { 'a2a.mjs': 'a2a.mjs', 'inbox.mjs': 'inbox.mjs', 'handle.mjs': 'handle.mjs', 'handoru.mjs': 'handoru.mjs', 'discover-sites.mjs': 'discover-sites.mjs' }[req.params.name];
    const path = file && join(CLI_DIST, file);
    if (!path || !existsSync(path)) return void res.status(404).send('not found');
    res.type('text/javascript').sendFile(path);
  });

  doorbell.startReringLoop();
  executor.startRecovery();
  return {
    app,
    db,
    executor,
    doorbell,
    close: async () => {
      doorbell.stop();
      await executor.stopRecovery();
      await db.kysely.destroy();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const { app } = createRelay(cfg);
  app.listen(cfg.port, () => {
    console.log(`relay listening on :${cfg.port}`);
    console.log(`agent card:   ${cfg.publicUrl}/${AGENT_CARD_PATH}`);
    console.log(`a2a endpoint: ${cfg.a2aEndpointUrl}`);
    console.log(`identities:   ${[...cfg.tokens.values()].map((i) => `${i.id}(${i.role})`).join(', ')}`);
    console.log(`webhook:      ${cfg.businessWebhook ? 'configured via env' : 'none in env (bot may register one: inbox set-doorbell)'}`);
  });
}
