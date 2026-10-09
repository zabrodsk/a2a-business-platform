import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentCard } from '@a2a-js/sdk';
import type { Request, Response, NextFunction } from 'express';
import { buildAgentCard } from '../../relay/src/card.js';
import type { Config, Identity } from '../../relay/src/config.js';
import { demoCustomer } from './demo-chat.js';
import { requireRole } from '../../relay/src/auth.js';
import { botRouter } from '../../relay/src/bot-api.js';
import { createRelay } from '../../relay/src/server.js';
import { RulebookManager, SourceRegistry } from '../../../packages/audit/index.js';
import { BusinessError, type Actor } from '../../../packages/contracts/index.js';
import type { AcceptedReply, RelayOperation } from '../../relay/src/config.js';
import { loadLegacyConfig, repoRoot, type LegacyConfig } from './config.js';
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
  if (cfg.env.HANDORU_FRESH !== 'true' && [...tokens.values()].filter(actor => actor.role === 'business').length !== 1) {
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
    demoPublicA2a: cfg.env.DEMO_PUBLIC_A2A === 'true',
    demoChatApproval: cfg.env.DEMO_CHAT_APPROVAL === 'true',
    demoOpenBusiness: cfg.env.DEMO_OPEN_BUSINESS === 'true',
    ...(cfg.env.HANDORU_FRESH==='true'?{}:{businessId:'pneu007'}),
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
      agentCard: () => AgentCard.toJSON(buildAgentCard({...relayConfig,demoOpenBusiness:relayConfig.demoOpenBusiness&&!legacy.handoru.isManagedContext()})),
      validateRelayTask: async (actor, taskId) => {
        if (actor.role !== 'customer_agent' || typeof taskId !== 'string') return false;
        const managedRow=legacy?.store.db.prepare('SELECT id FROM handoru_relays WHERE business_id=?').get(legacy.handoru.installation()?.id??'') as {id:string}|undefined;
        if(managedRow){const resource=await ensureManaged(managedRow.id);const found=resource.db.sqlite.prepare('SELECT owner FROM work_items WHERE task_id=? LIMIT 1').get(taskId) as {owner:string}|undefined;if(found)return found.owner===actor.id;}
        const row = relay.db.sqlite.prepare('SELECT owner FROM work_items WHERE task_id = ? LIMIT 1')
          .get(taskId) as { owner: string } | undefined;
        return row?.owner === actor.id;
      },
    });
  } catch (error) {
    await relay.close();
    throw error;
  }
  Object.defineProperty(relayConfig,'demoOpenBusiness',{enumerable:true,get:()=>cfg.env.DEMO_OPEN_BUSINESS==='true'&&!legacy.handoru.isManagedContext()});
  if (cfg.env.DEMO_CHAT_APPROVAL === 'true' && cfg.env.DEMO_PUBLIC_A2A === 'true') relayConfig.demoCustomerId = session => demoCustomer(legacy.store, session).customer_id!;
  const resolveIdentity=(token:string,businessId?:string):Identity|undefined=>{
    if(!businessId&&token===cfg.env.LEGACY_RELAY_ADMIN_TOKEN)return {id:'relay-admin',role:'admin'};
    const dynamic=legacy.customerIdentity.federation?.identify(token)??legacy.handoru.identify(token)??legacy.agentAuth.identify(token);
    const actor=dynamic??cfg.auth.agentTokens.get(token);
    if(!actor||actor.role==='business_agent'&&!dynamic)return;
    if(actor.role==='business_agent'&&businessId&&actor.business_id!==businessId)return;
    if(actor.role==='customer_agent'&&actor.connection_id&&businessId&&actor.business_id!==businessId)return;
    if(!['business_agent','customer_agent','unclaimed_agent'].includes(actor.role))return;
    return {...actor,role:actor.role==='business_agent'?'business':actor.role==='customer_agent'?'customer':'unclaimed',...(businessId?{business_id:businessId}:{})};
  };
  const checkIdentity=(identity:Identity,operation?:RelayOperation)=>{
    if(identity.role==='admin')return operation===undefined;
    if(identity.role==='customer')return (!identity.connection_id || !!identity.scopes?.includes('a2a')) && (operation==='a2a'||operation===undefined);
    if(identity.role!=='business')return false;
    const scope=operation==='inbox.reply'?'inbox.reply':'inbox.claim';
    try{legacy.handoru.authorize({...identity,role:'business_agent'},identity.business_id!,scope,true);return true;}catch{return false;}
  };
  relayConfig.lookupToken=token=>resolveIdentity(token);
  relayConfig.checkIdentity=checkIdentity;
  const active=(businessId:string)=>{try{const b=legacy.handoru.business(businessId);if(!b.active_connection_id)return false;new RulebookManager(legacy.store.db,new SourceRegistry(legacy.registry.rootDir,legacy.registry.webSources,legacy.registry.includeFixtures),{businessId:b.id,genericEvidence:b.id!=='pneu007'}).getActive();return legacy.handoru.connection(b.active_connection_id).state==='active';}catch{return false;}};
  relayConfig.isActive=()=>cfg.env.HANDORU_FRESH!=='true'&&active('pneu007');
  if(cfg.env.HANDORU_FRESH==='true')legacy.app.use(['/a2a/jsonrpc','/bot'],(_req,res)=>res.status(404).json({error:'MANAGED_RELAY_REQUIRED',bootstrap:'/.well-known/handle.json'}));
  const authorityHooks=(businessId:string):Pick<Config,'acceptReply'|'pendingReplies'|'markReplyDelivered'>=>({
    acceptReply:(record,identity)=>{
      if(!checkIdentity(identity,'inbox.reply')||record.business_id!==businessId)throw new BusinessError('STALE_EXECUTION','Reply authority revoked.',409);
      return legacy.store.db.transaction(()=>{
        const old=legacy.store.db.prepare('SELECT business_id,record_json FROM handoru_reply_outbox WHERE work_item_id=?').get(record.work_item_id) as {business_id:string;record_json:string}|undefined;
        if(old){if(old.business_id!==businessId)throw new BusinessError('FORBIDDEN','Reply belongs to another business.',403);return JSON.parse(old.record_json) as AcceptedReply;}
        legacy.store.db.prepare('INSERT INTO handoru_reply_outbox VALUES(?,?,?,0)').run(record.work_item_id,businessId,JSON.stringify(record));return record;
      }).immediate();
    },
    pendingReplies:()=> (legacy.store.db.prepare('SELECT record_json FROM handoru_reply_outbox WHERE business_id=? AND delivered=0').all(businessId) as {record_json:string}[]).map(r=>JSON.parse(r.record_json) as AcceptedReply),
    markReplyDelivered:workItemId=>{legacy.store.db.prepare('UPDATE handoru_reply_outbox SET delivered=1 WHERE work_item_id=? AND business_id=?').run(workItemId,businessId);},
  });
  if(relayConfig.businessId){
    Object.assign(relayConfig,authorityHooks(relayConfig.businessId));
    const compatibilityToken=cfg.env.LEGACY_BUSINESS_AGENT_TOKEN;
    const compatibilityIdentity=compatibilityToken?resolveIdentity(compatibilityToken):undefined;
    if(compatibilityIdentity?.connection_id==='compatibility-pneu007')relay.doorbell.migrateCompatibilityWebhook(compatibilityIdentity);
  }
  const managed=new Map<string,Promise<ReturnType<typeof createRelay>>>();
  const ensureManaged=(relayId:string)=>{
    let pending=managed.get(relayId);if(pending)return pending;
    const resource=legacy.store.db.prepare('SELECT id,business_id,endpoint FROM handoru_relays WHERE id=?').get(relayId) as {id:string;business_id:string;endpoint:string}|undefined;
    if(!resource)throw new BusinessError('RELAY_NOT_FOUND','Unknown relay.',404);
    pending=(async()=>{
      const dbPath=resolve(dirname(cfg.dbPath),`${resource.id}.db`);await migrateRelayDatabase(dbPath);
      const resourceConfig:Config={...relayConfig,demoOpenBusiness:false,demoPublicA2a:relayConfig.demoPublicA2a && resource.business_id==='pneu007',dbPath,publicUrl:resource.endpoint.replace(/\/a2a$/,''),a2aPath:'/a2a',a2aEndpointUrl:resource.endpoint,businessId:resource.business_id,tokens:new Map(),lookupToken:token=>resolveIdentity(token,resource.business_id),checkIdentity,isActive:()=>active(resource.business_id),
        ...authorityHooks(resource.business_id),
      };
      return createRelay(resourceConfig);
    })();managed.set(relayId,pending);pending.catch(()=>managed.delete(relayId));return pending;
  };
  legacy.app.use('/relay/:relayId',async(req,res,next)=>{
    try{const instance=await ensureManaged(String(req.params.relayId));instance.app(req,res,next);}catch(error){next(error);}
  });
  // Cases remain in the native authority; transport ownership is verified per isolated resource.
  // Initial compatibility relay retains its own stable task store.

  const openDemoInbox = botRouter({ ...relayConfig, demoOnlyOwners: true }, relay.db, relay.doorbell, relay.executor);
  legacy.app.use('/demo-business/bot', (req, res, next) => {
    if (cfg.env.DEMO_OPEN_BUSINESS !== 'true' || cfg.env.DEMO_CHAT_APPROVAL !== 'true' || cfg.env.DEMO_PUBLIC_A2A !== 'true'
      || cfg.env.HANDORU_FRESH === 'true' || legacy.handoru.installation()?.id !== 'pneu007' || legacy.handoru.isManagedContext()) return void res.status(404).json({ error: 'DEMO_DISABLED' });
    const routes: Record<string, string[]> = { '/inbox': ['GET'], '/wait': ['GET'], '/reply': ['POST'], '/scheduled-check-in': ['POST'], '/availability': ['GET'], '/doorbell': ['GET','POST'], '/doorbell/ack': ['POST'] };
    if (!routes[req.path]?.includes(req.method)) return void res.status(404).json({ error: 'Unknown open demo operation' });
    // Use the already configured fictional shop internally; never return its credential.
    const token = cfg.env.LEGACY_BUSINESS_AGENT_TOKEN;
    if (!token || !active('pneu007')) return void res.status(503).json({ error: 'DEMO_UNAVAILABLE' });
    req.headers.authorization = `Bearer ${token}`;
    openDemoInbox(req, res, next);
  });


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
  legacy.app.use((error:unknown,_req:Request,res:Response,next:NextFunction)=>{if(res.headersSent)return next(error);if(error instanceof BusinessError)return void res.status(error.status).json({error:{code:error.code,message:error.message}});res.status(error instanceof SyntaxError?400:500).json({error:{code:error instanceof SyntaxError?'INVALID_JSON':'INTERNAL_ERROR'}});});

  let closed = false;
  return {
    ...legacy, relay, relayConfig,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...managed.values()].map(async p=>(await p).close()));
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
