import { createHostedDiscovery } from '../../../packages/agent-client/src/hosted-discovery.js';
import type { DocumentFetcher } from '../../../packages/agent-client/src/website-discovery.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BusinessError, type Actor, type PaymentJob, type PaymentProvider, type PurchaseAuthorization } from '../../../packages/contracts/index.js';
import { LegacyStore, calculatePrice, BOOKING_CONFIG, type Order, type PaymentIntent } from '../../../packages/demo-garage/index.js';
import { SourceRegistry, RulebookManager } from '../../../packages/audit/index.js';
import { createPaymentProvider, paymentProviderStatus, selectPaymentSku, DEMO_SELLER } from '../../../packages/payments/index.js';
import { LegacyAuth } from './auth.js';
import { AgentAuth } from './agent-auth.js';
import { HandoruStore } from './handoru/store.js';
import { importCompatibility } from './handoru/onboarding.js';
import { renderAgentGuide } from '../../relay/src/agent-guide.js';
import { handoruRoutes } from './handoru/routes.js';
import { assertCapabilities } from './handoru/capabilities.js';
import { handoruManifest } from './handoru/manifest.js';
import { pneuMcp } from './mcp.js';
import { AgentPolicy } from './agent-policy.js';
import { PaymentWorkflow } from './payment-workflow.js';
import { StripeCheckoutWorkflow } from './stripe-checkout.js';
import { loadLegacyConfig, repoRoot, type LegacyConfig } from './config.js';
import { GARAGE_TOOLS } from '../../../packages/agent-client/src/garage-tools.js';
import { loadProfile } from '../../relay/src/card.js';

export interface LegacyOptions {
  discoveryFetchDocument?: DocumentFetcher;
  now?: () => Date;
  paymentProvider?: PaymentProvider;
  paymentStatus?: () => ReturnType<typeof paymentProviderStatus>;
  stripeFetch?: typeof fetch;
  registry?: SourceRegistry;
  agentCard?: () => unknown;
  validateRelayTask?: (actor: Actor, taskId: string) => Promise<boolean>;
}
function fail(code: string, message: string, status = 400): never { throw new BusinessError(code, message, status); }
function actor(req: Request): Actor { return req.legacyActor ?? fail('UNAUTHENTICATED', 'Přihlaste se.', 401); }
function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || !value || value.length > 200) fail('INVALID_ID', 'Neplatný identifikátor.');
  return value;
}
function query(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 200) fail('INVALID_QUERY', 'Neplatný parametr.');
  return value;
}
function integer(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('INVALID_INPUT', `${label} musí být celé nezáporné číslo.`);
  return Number(value);
}
const publicDirectory = join(repoRoot, 'apps/legacy/public');

/** Independent legacy business. A2A transport is attached separately by createUnifiedSystem. */
export function createLegacy(cfg: LegacyConfig, options: LegacyOptions = {}) {
  const now = options.now ?? (() => new Date());
  const store = new LegacyStore(cfg.dbPath, { now });
  const agentAuth = new AgentAuth(store.db, { publicUrl: cfg.publicUrl, now });
  const handoru = new HandoruStore(store.db,cfg.publicUrl,now);
  importCompatibility(handoru,cfg.auth.agentTokens,cfg.env.HANDORU_FRESH==='true');
  const auth = new LegacyAuth(store.db, { ...cfg.auth, now, agentTokens:new Map([...cfg.auth.agentTokens].filter(([,a])=>a.role!=='business_agent')), lookupAgentToken: token => handoru.identify(token) ?? agentAuth.identify(token) });
  const registry = options.registry ?? new SourceRegistry(repoRoot);
  const rulebooks = new RulebookManager(store.db, registry);
  const businessIdentity = [...cfg.auth.agentTokens.values()].find(value => value.role === 'business_agent');
  const policy = new AgentPolicy(store, rulebooks, { now, businessActorId: businessIdentity?.id ?? 'garage-demo', businessId:()=>handoru.installation()?.id??'pneu007', authorizeBusiness: a=>handoru.authorize(a,handoru.installation()?.id??'pneu007','inbox.claim',true),onEvent:(entity,entityId,kind,a,data)=>{const b=handoru.installation();if(b)handoru.event(b.id,`native.${entity}.${kind}`,a.id,{entity_id:entityId,detail:data});} });
  handoru.validateActive=(a,b,c,scope)=>{
    const active=new RulebookManager(store.db,new SourceRegistry(registry.rootDir,registry.webSources,registry.includeFixtures),{businessId:b.id,genericEvidence:b.id!=='pneu007'}).getActive();
    assertCapabilities(active.governance?.required_capabilities??[],Boolean(store.db.prepare('SELECT 1 FROM handoru_meta WHERE key=?').get(`mcp_verified:${c.id}`)));
    if(c.id!=='compatibility-pneu007'&&JSON.parse(c.ready_json??'{}').rulebook_hash!==active.payload_hash)fail('CAPABILITY_PROBE_REQUIRED','Acknowledge the exact active rulebook before operating.',409);
    if(scope==='orders.checkout'&&active.params.deposit_minor!==BOOKING_CONFIG.deposit_minor)fail('UNSUPPORTED_NATIVE_POLICY','Approved deposit differs from native checkout configuration; human reconciliation required.',409);
  };
  const handoruApi=handoruRoutes(handoru,rulebooks,policy,cfg.env);
  const currentBusinessIdentity = ():Actor|undefined => {
    const b=handoru.installation();if(!b?.active_connection_id)return;
    const c=handoru.connection(b.active_connection_id);return {id:c.principal_id,role:'business_agent',business_id:b.id,connection_id:c.id,execution_epoch:b.execution_epoch,scopes:JSON.parse(c.scopes_json)};
  };
  const provider = options.paymentProvider ?? createPaymentProvider(cfg.env, { now });
  const processor = new PaymentWorkflow(store, provider);
  const stripe = new StripeCheckoutWorkflow(store, { env: cfg.env, publicUrl: cfg.publicUrl, fetch: options.stripeFetch, now });
  const providerStatus = options.paymentStatus ?? (() => paymentProviderStatus(cfg.env));
  const jobPreparations = new Map<string, Promise<PaymentJob>>();
  store.db.exec(`CREATE TABLE IF NOT EXISTS human_checkout_authorizations(order_id TEXT PRIMARY KEY REFERENCES orders(id),actor_id TEXT NOT NULL,authorization_json TEXT NOT NULL,approved_at TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS order_contact_snapshots(order_id TEXT PRIMARY KEY REFERENCES orders(id),name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL);`);
  store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_case_relay_task_identity ON agent_cases(json_extract(payload_json,'$.relay_task_id')) WHERE json_extract(payload_json,'$.relay_task_id') IS NOT NULL;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS masumi_jobs(id TEXT PRIMARY KEY REFERENCES payment_intents(id),customer_id TEXT NOT NULL,identifier_from_purchaser TEXT NOT NULL,job_json TEXT NOT NULL,input_json TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS business_registry_proof(id INTEGER PRIMARY KEY CHECK(id=1),business_id TEXT NOT NULL,challenge TEXT NOT NULL,published_by TEXT NOT NULL,published_at TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS business_agent_enrollments(code_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,created_by TEXT NOT NULL);`);

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'same-origin').set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Link', `</agents.md>; rel="describedby"; type="text/markdown", </.well-known/handle.json>; rel="service-desc"; type="application/json", </.well-known/agent-card.json>; rel="agent-card"; type="application/json"`);
    next();
  });
  app.get('/agents.md', (_req, res) => res.set('Cache-Control', 'no-cache').type('text/markdown').send(renderAgentGuide(cfg.publicUrl, cfg.env.DEMO_PUBLIC_A2A === 'true')));
  const scanWebsites = createHostedDiscovery({ fetchDocument: options.discoveryFetchDocument, now: () => now().getTime() });
  const discoveryJson = express.json({ limit: '32kb' });
  app.post('/discovery/websites', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    discoveryJson(req, res, error => {
      if (error) { res.status(400).json({ error: 'Invalid discovery request' }); return; }
      next();
    });
  }, async (req, res) => {
    const result = await scanWebsites(req.body);
    if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
    res.status(result.status).json(result.body);
  });

  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) fail('INVALID_STRIPE_WEBHOOK', 'Stripe webhook requires an unmodified JSON body.');
    await stripe.webhook(req.body, req.get('stripe-signature'));
    res.json({ received: true });
  });
  app.use('/api', express.json({ limit: '3mb' }), auth.middleware, (req,res,next)=>{if(/^\/(?:handle|handoru)\/v1(?:\/|$)/.test(req.path)||/^\/admin\/(rulebooks\/[^/]+\/activate|approvals\/[^/]+\/decide)$/.test(req.path))return next();auth.protect(req,res,next);});
  app.use('/api', (_req,_res,next)=>{const b=handoru.installation();if(b)rulebooks.useBusiness(b.id,{genericEvidence:b.id!=='pneu007'});next();});
  app.use(['/api/handle/v1','/api/handoru/v1'],handoruApi.router);
  app.use('/mcp',pneuMcp(auth,handoru));
  app.get(['/.well-known/handle.json','/.well-known/handoru.json'],(_req,res)=>res.set('Cache-Control','no-store').json(handoruManifest(cfg.publicUrl,cfg.env.DEMO_PUBLIC_A2A==='true')));
  app.get(['/handle/onboarding','/handoru/onboarding'],(_req,res)=>res.sendFile(join(repoRoot,'docs/handoru-onboarding.html')));
  app.get(['/skills/handle-onboarding/SKILL.md','/skills/handoru-onboarding/SKILL.md'],(_req,res)=>res.type('text/markdown').sendFile(join(repoRoot,'skills/handoru-onboarding/SKILL.md')));
  app.get(['/.well-known/handle-ownership.json','/.well-known/handoru-ownership.json'],(_req,res)=>{const p=store.db.prepare("SELECT value FROM handoru_meta WHERE key='ownership_proof'").get() as {value:string}|undefined;res.set('Cache-Control','no-store');if(!p)return void res.status(404).json({error:'NO_OWNERSHIP_PROOF'});res.json(JSON.parse(p.value));});
  app.post(['/api/admin/handle-ownership-proof','/api/admin/handoru-ownership-proof'],auth.require('owner'),(req,res)=>{const challenge=req.body?.challenge;if(typeof challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge))fail('INVALID_CHALLENGE','Use the challenge from your registration.');store.db.prepare("INSERT INTO handoru_meta VALUES('ownership_proof',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({challenge}));res.json({ok:true,path:'/.well-known/handle-ownership.json'});});
  app.use(['/api/audit','/api/suppliers'],(req,_res,next)=>{try{if(req.legacyActor?.role==='business_agent')handoru.authorize(req.legacyActor,handoru.installation()?.id??'pneu007','audit.read');next();}catch(error){next(error);}});
  app.use('/api/agent',(req,_res,next)=>{
    try{const a=req.legacyActor;if(a?.role==='business_agent'){
      const scope=req.path.includes('rulebook/proposals')?'audit.propose':req.path.includes('/site/')?'website.agent-card.publish':req.path.includes('registry-proof')?'registry.publish':req.path.endsWith('/checkout')?'orders.checkout':req.path.endsWith('/quotes')?'cases.quote':req.path.includes('rulebook')||req.path==='/skill'?'audit.read':'inbox.claim';
      const c=handoru.authorize(a,handoru.installation()?.id??'pneu007',scope,!['audit.read','audit.propose'].includes(scope));
      if(!['audit.read','audit.propose'].includes(scope)&&c.id!=='compatibility-pneu007'&&JSON.parse(c.ready_json??'{}').rulebook_hash!==rulebooks.getActive().payload_hash)fail('CAPABILITY_PROBE_REQUIRED','Connection must acknowledge the active rulebook.',409);
    }next();}catch(error){next(error);}
  });
  app.use(['/api/admin/rulebooks/:version/activate','/api/admin/approvals/:id/decide'],handoruApi.human,(req,_res,next)=>{const b=handoru.installation();if(!b)return next(new BusinessError('BUSINESS_REQUIRED','Complete onboarding first.',409));handoru.bindNativeOwner(req.handoruHuman!.owner,b.id);req.legacyActor={id:req.handoruHuman!.owner.id,role:'owner'};next();});
  app.post('/api/agent/site/agent-card',auth.require('business_agent'),(req,res)=>{
    const a=actor(req),publicationId=req.body?.publication_id;
    if(typeof publicationId!=='string'||!publicationId||publicationId.length>200)fail('INVALID_PUBLICATION_ID','Supply the prepared publication ID.');
    const result=handoru.operation(a,req.header('idempotency-key')??'','website.publish',{publication_id:publicationId},'website.agent-card.publish',()=>{
      rulebooks.getActive();
      const p=store.db.prepare('SELECT id,descriptor_json,rulebook_hash FROM handoru_publications WHERE id=? AND business_id=?').get(publicationId,a.business_id!) as {id:string;descriptor_json:string;rulebook_hash:string}|undefined;
      if(!p)fail('PUBLICATION_NOT_FOUND','Create a scoped publication first.',404);
      if(p.rulebook_hash!==rulebooks.getActive().payload_hash)fail('PUBLICATION_STALE','Create a new publication for the active reviewed rulebook.',409);
      store.db.prepare("INSERT INTO handoru_meta VALUES('site_agent_card',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({business_id:a.business_id,publication_id:p.id,rulebook_hash:p.rulebook_hash,descriptor:JSON.parse(p.descriptor_json)}));
      store.db.prepare("UPDATE handoru_publications SET state='written' WHERE id=?").run(p.id);return {id:p.id,state:'written',card_url:'/.well-known/agent-card.json',visible_link:true};
    });res.json(result);
  });
  app.use('/masumi', express.json({ limit: '64kb' }), auth.middleware, auth.protect);
  app.use(agentAuth.router(auth));
  const human = auth.require('human_customer');
  const operators = auth.require('owner', 'staff');
  const owner = auth.require('owner');
  const auditReaders = auth.require('owner', 'staff', 'business_agent');
  const agents = auth.require('business_agent', 'customer_agent');
  const business = auth.require('business_agent');

  app.post('/api/admin/agent-enrollments',(_req,res)=>res.set('Cache-Control','no-store').status(410).json({error:'ENROLLMENT_REPLACED',bootstrap:'/.well-known/handle.json'}));
  app.get('/agent-enrollments/:code', (_req, res) => {
    res.set('Cache-Control', 'no-store').set('Allow', 'POST').status(405).json({ error: 'Use the business CLI to redeem this link.' });
  });
  app.post('/agent-enrollments/:code', (_req,res)=>res.set('Cache-Control','no-store').status(410).json({error:'ENROLLMENT_REPLACED',bootstrap:'/.well-known/handle.json'}));

  function event(entity: string, id: string, kind: string, by: string, detail: unknown) {
    store.db.prepare('INSERT INTO audit_events(entity_type,entity_id,event_type,actor_id,data_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(entity, id, kind, by, JSON.stringify(detail), now().toISOString());
  }
  function ownOrder(req: Request, id: string): Order {
    const record = store.getOrder(id), principal = actor(req);
    if (principal.role === 'owner' || principal.role === 'staff') return record;
    if (principal.role === 'human_customer' && principal.customer_id === record.customer_id) return record;
    if (['business_agent', 'customer_agent'].includes(principal.role) && policy.listCases(principal).some(value => value.order_id === record.id)) return record;
    return fail('FORBIDDEN', 'Objednávka patří jiné identitě.', 403);
  }
  function intentForOrder(orderId: string) { return store.listPaymentIntents().find(value => value.order_id === orderId); }
  function stripeView(orderId: string) {
    const checkout = store.getStripeCheckoutForOrder(orderId);
    if (!checkout) return null;
    return { id: checkout.id, state: checkout.state, payment_mode: checkout.payment_mode,
      amount_minor: checkout.amount_minor, currency: checkout.currency, mode: 'test',
      checkout_url: checkout.checkout_url, expires_at: checkout.expires_at,
      session_id: checkout.session_id, payment_intent_id: checkout.payment_intent_id };
  }
  function orderView(record: Order) {
    const quote = store.getQuote(record.quote_id), intent = intentForOrder(record.id);
    const booking = store.calendar(record.customer_id).find(value => value.order_id === record.id);
    const contact = store.db.prepare('SELECT name,email,phone FROM order_contact_snapshots WHERE order_id=?').get(record.id)
      ?? store.db.prepare('SELECT name,email,phone FROM customers WHERE id=?').get(record.customer_id);
    return { order: record, quote, contact, payment: intent ?? null, intent: intent ?? null, booking: booking ?? null,
      stripe_checkout: stripeView(record.id),
      receipt: intent ? processor.getReceipt(intent.intent_id) ?? null : null,
      payment_error: intent ? processor.error(intent.intent_id) ?? null : null,
      simulation: intent?.provider === 'local_demo' };
  }
  function mapping(order: Order, paymentMode: unknown, fee: unknown) {
    if (!['deposit', 'full'].includes(String(paymentMode))) fail('INVALID_PAYMENT_MODE', 'Vyberte zálohu nebo plnou úhradu.');
    const mode = paymentMode as 'deposit' | 'full';
    const amount = mode === 'deposit' ? BOOKING_CONFIG.deposit_minor : store.getQuote(order.quote_id).price.total_minor;
    const status = providerStatus();
    if (!status.configured || ('purchase_ready' in status && !status.purchase_ready)) fail('PAYMENT_NOT_READY', ('reason' in status && status.reason) || 'Platební provider zatím není připraven.', 503);
    if (provider.name === 'masumi' && store.listPaymentIntents().some(intent => intent.order_id !== order.id && intent.provider === 'masumi' && !['created', 'failed', 'refunded', 'seller_paid'].includes(intent.state))) {
      fail('MASUMI_BUYER_WALLET_BUSY', 'Jiný nákup stále vlastní lifecycle testovací peněženky.', 409);
    }
    if (typeof fee !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(fee)) fail('INVALID_FEE_CAP', 'Potvrďte maximální síťový poplatek v nejmenších jednotkách.');
    return { ...selectPaymentSku({ payment_mode: mode, amount_minor: amount, max_network_fee: fee,
      network: provider.name === 'masumi' ? 'Preprod' : 'local' }, cfg.env), provider: provider.name, paymentMode: mode, amount };
  }
  async function checkoutHuman(req: Request, order: Order) {
    const principal = actor(req);
    if (principal.role !== 'human_customer' || principal.customer_id !== order.customer_id) fail('FORBIDDEN', 'Nákup musí potvrdit příslušný lidský zákazník.', 403);
    if (req.body?.confirm !== true) fail('HUMAN_CONFIRMATION_REQUIRED', 'Potvrďte konkrétní nákup, termín a platební podmínky.', 403);
    const selected = mapping(order, req.body.payment_mode, req.body.max_network_fee);
    const quote = store.getQuote(order.quote_id);
    const authorization: PurchaseAuthorization = { kind: 'human_checkout', actor_id: principal.id, customer_id: order.customer_id,
      quote_id: quote.id, quote_version: quote.version, payment_mode: selected.paymentMode, max_total_minor: quote.price.total_minor,
      max_deposit_minor: BOOKING_CONFIG.deposit_minor, network: selected.network, seller_id: selected.seller_id,
      asset: selected.asset, asset_quantity: selected.asset_quantity, max_network_fee: selected.max_network_fee,
      mapping_version: selected.mapping_version, approved_at: now().toISOString() };
    const existing = store.db.prepare('SELECT authorization_json FROM human_checkout_authorizations WHERE order_id=?').get(order.id) as { authorization_json: string } | undefined;
    const persisted = existing ? JSON.parse(existing.authorization_json) as PurchaseAuthorization : authorization;
    if (persisted.actor_id !== principal.id || persisted.payment_mode !== authorization.payment_mode
      || persisted.max_network_fee !== authorization.max_network_fee || persisted.network !== authorization.network
      || persisted.asset_quantity !== authorization.asset_quantity || persisted.seller_id !== authorization.seller_id) fail('IMMUTABLE_CHECKOUT', 'Nákup byl již autorizován s jinými podmínkami.', 409);
    if (!existing) {
      store.db.prepare('INSERT INTO human_checkout_authorizations VALUES(?,?,?,?)').run(order.id, principal.id, JSON.stringify(authorization), authorization.approved_at);
      event('order', order.id, 'human_checkout_authorized', principal.id, { quote_id: quote.id, payment_mode: authorization.payment_mode });
    }
    const intent = store.prepareCheckout(order.id, { authorization: persisted, ...selected });
    await processor.reconcile(intent.intent_id);
    return { ...orderView(store.getOrder(order.id)), intent: store.getPaymentIntent(intent.intent_id) };
  }
  function prepareAgentCheckout(principal: Actor, order: Order, overrides: { purchaser_identifier?: string; input_hash?: string } = {}): PaymentIntent {
    const mandateCase = policy.listCases(principal).find(value => value.order_id === order.id);
    if (!mandateCase?.mandate_id) fail('MANDATE_REQUIRED', 'Objednávka není přijata v rámci schváleného mandátu.', 403);
    const row = store.db.prepare('SELECT payload_json FROM agent_mandates WHERE id=?').get(mandateCase.mandate_id) as { payload_json: string };
    const mandate = JSON.parse(row.payload_json) as { payment_mode: string; max_network_fee: string };
    const selected = mapping(order, mandate.payment_mode, mandate.max_network_fee);
    const authorization = policy.authorizationForCheckout(principal, order.id, {
      provider: selected.provider, network: selected.network, seller_id: selected.seller_id, asset: selected.asset,
      asset_quantity: selected.asset_quantity, max_network_fee: selected.max_network_fee, mapping_version: selected.mapping_version,
    });
    return store.prepareCheckout(order.id, { authorization, ...selected, ...overrides });
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, business: 'Pneu 007', fictional: true }));
  app.get('/api/session', (req, res) => res.json({ actor: req.legacyActor ?? null, csrf_token: req.legacySession?.csrf ?? null }));
  app.post('/api/login', (req, res) => res.json(auth.login(req, res)));
  app.post('/api/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  app.get('/api/services', (_req, res) => res.json(store.catalog()));
  app.post('/api/pricing/calculate', (req, res) => {
    if (req.body?.discount_bps !== undefined) fail('DISCOUNT_FORBIDDEN', 'Veřejný kalkulátor nezadává interní slevu.');
    res.json(calculatePrice(req.body?.service_spec));
  });
  app.get('/api/availability', (req, res) => res.json({ slots: store.availability({ from: query(req, 'from'), to: query(req, 'to'), service_id: query(req, 'service_id') }), timezone: 'Europe/Prague' }));
  app.get('/api/payments/config', (_req, res) => {
    const status = providerStatus();
    res.json({ ...status, available_skus: 'skus' in status ? status.skus : [], asset: 'lovelace',
      stripe_link: stripe.status(),
      seller_id: provider.name === 'masumi' ? cfg.env.MASUMI_SELLER_VKEY : DEMO_SELLER });
  });
  app.post('/api/inquiries', (req, res) => {
    const input = req.body ?? {};
    const inquiry = store.createInquiry({ name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Demo zákazník',
      email: input.email, phone: input.phone, service_spec: input.service_spec,
      location_id: input.location_id, customer_id: req.legacyActor?.role === 'human_customer' ? req.legacyActor.customer_id : undefined });
    res.status(201).json({ inquiry, id: inquiry.id, booking_created: false, payment_created: false });
  });
  app.post('/api/orders', human, (req, res) => {
    if (req.body?.discount_bps !== undefined || req.body?.customer_id !== undefined) fail('UNSUPPORTED_INPUT', 'Cena a zákazník jsou odvozeni serverem.');
    let contact: { name: string; email: string; phone: string } | undefined;
    if (['name', 'email', 'phone'].some(key => req.body?.[key] !== undefined)) {
      const { name, email, phone } = req.body;
      if ((name !== undefined && (typeof name !== 'string' || name.length > 200))
        || typeof email !== 'string' || email.length > 250 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || typeof phone !== 'string' || !phone.trim() || phone.length > 80) fail('INVALID_CONTACT', 'Vyplňte platný e-mail a telefon.');
      contact = { name: name?.trim() || 'Demo zákazník', email: email.trim(), phone: phone.trim() };
    }
    const quote = store.createQuote({ customer_id: actor(req).customer_id!, service_spec: req.body?.service_spec,
      slot_id: req.body?.slot_id, requires_owner_approval: false });
    const order = store.createOrder(quote.id);
    if (contact) store.db.prepare('INSERT INTO order_contact_snapshots VALUES(?,?,?,?)').run(order.id, contact.name, contact.email, contact.phone);
    res.status(201).json({ order, quote, contact: contact ?? null });
  });
  app.get('/api/orders/:id', auth.require('owner', 'staff', 'human_customer'), (req, res) => res.json(orderView(ownOrder(req, param(req, 'id')))));
  app.post('/api/orders/:id/checkout', human, async (req, res) => res.json(await checkoutHuman(req, ownOrder(req, param(req, 'id')))));
  app.post('/api/orders/:id/link-checkout', human, async (req, res) => {
    const order = ownOrder(req, param(req, 'id'));
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['payment_mode', 'confirm'].includes(key))
      || !['deposit', 'full'].includes(input.payment_mode) || input.confirm !== true) {
      fail('STRIPE_APPROVAL_REQUIRED', 'Choose the payment mode and explicitly approve this Stripe test checkout.');
    }
    await stripe.start(order.id, { id: actor(req).id, customer_id: actor(req).customer_id }, input);
    res.json({ stripe_checkout: stripeView(order.id) });
  });
  app.get('/api/orders/:id/link-payment', auth.require('owner', 'staff', 'human_customer'), async (req, res) => {
    const order = ownOrder(req, param(req, 'id'));
    const checkout = store.getStripeCheckoutForOrder(order.id);
    if (checkout) await stripe.reconcile(checkout.id);
    res.json(orderView(store.getOrder(order.id)));
  });
  app.get('/api/orders/:id/payment', auth.require('owner', 'staff', 'human_customer'), async (req, res) => {
    const record = ownOrder(req, param(req, 'id')), intent = intentForOrder(record.id);
    if (intent) await processor.reconcile(intent.intent_id);
    res.json(orderView(store.getOrder(record.id)));
  });
  app.get('/api/orders/:id/confirmation.ics', auth.require('owner', 'staff', 'human_customer'), (req, res) => {
    const record = ownOrder(req, param(req, 'id'));
    const booking = store.calendar(record.customer_id).find(value => value.order_id === record.id && value.status === 'confirmed');
    if (!booking) fail('BOOKING_NOT_CONFIRMED', 'Rezervace dosud nebyla potvrzena.', 409);
    res.type('text/calendar').set('Content-Disposition', 'attachment; filename="pneu007-rezervace.ics"').send(store.ics(booking.id));
  });

  app.get('/api/admin/overview', operators, (_req, res) => {
    const orders = store.listOrders(), calendar = store.calendar();
    res.json({ order_count: orders.length, booking_count: calendar.filter(value => value.status === 'confirmed').length,
      customer_count: store.customers().length, pending_inquiries: (store.db.prepare('SELECT count(*) AS n FROM inquiries').get() as { n: number }).n,
      payment_provider: providerStatus(), orders: orders.slice(0, 5).map(orderView), calendar, fictional: true });
  });
  app.get('/api/admin/orders', operators, (_req, res) => res.json({ orders: store.listOrders().map(value => ({ ...value, ...orderView(value) })) }));
  app.get('/api/admin/calendar', operators, (_req, res) => res.json({ calendar: store.calendar(), events: store.calendar(), bookings: store.calendar(), holds: store.db.prepare('SELECT * FROM booking_holds WHERE status IN (?,?)').all('active', 'reconciliation'), slots: store.availability() }));
  app.get('/api/admin/customers', operators, (_req, res) => res.json({ customers: store.customers(), vehicles: store.vehicles() }));
  app.get('/api/admin/inventory', operators, (_req, res) => res.json({ inventory: store.inventory() }));
  app.get('/api/admin/partners', operators, (_req, res) => res.json({ partners: store.partners() }));
  app.get('/api/admin/partners/:id/catalog', operators, (req, res) => res.json({ inventory: store.inventory(param(req, 'id')) }));
  app.get('/api/admin/partners/:id/stock', operators, (req, res) => res.json({ inventory: store.inventory(param(req, 'id')) }));
  app.get('/api/admin/partners/:id/quotes', operators, (req, res) => res.json({ quotes: store.supplierQuotes(param(req, 'id')) }));
  app.post('/api/admin/partners/:id/rfq', operators, (req, res) => res.status(201).json({ quote: store.draftSupplierQuote({ supplier_id: param(req, 'id'), sku: req.body?.sku, quantity: req.body?.quantity, actor_id: actor(req).id }), simulation: true }));
  app.post('/api/admin/inventory/:id', operators, (req, res) => res.json({ item: store.updateInventory(param(req, 'id'), req.body, actor(req).id) }));
  app.post('/api/admin/orders/:id/reschedule', operators, (req, res) => {
    const order = ownOrder(req, param(req, 'id')), booking = store.calendar(order.customer_id).find(value => value.order_id === order.id);
    if (!booking) fail('BOOKING_NOT_FOUND', 'Objednávka nemá potvrzený termín.', 409);
    res.json({ booking: store.reschedule(booking.id, req.body?.slot_id, actor(req).id) });
  });
  app.post('/api/admin/orders/:id/cancel', operators, async (req, res) => {
    const record = ownOrder(req, param(req, 'id')), intent = intentForOrder(record.id);
    if (intent && ['escrow_funded', 'result_submitted', 'seller_paid', 'refund_requested'].includes(intent.state) && actor(req).role !== 'owner') fail('OWNER_REQUIRED', 'Řešení financované objednávky vyžaduje majitele.', 403);
    store.cancelOrder(record.id, actor(req).id);
    if (intent && ['escrow_funded', 'result_submitted', 'seller_paid'].includes(intent.state)) await processor.requestRefund(intent.intent_id);
    res.json(orderView(store.getOrder(record.id)));
  });
  app.post('/api/admin/orders/:id/refund-request', owner, async (req, res) => {
    const order = ownOrder(req, param(req, 'id')), intent = intentForOrder(order.id);
    if (!intent) fail('PAYMENT_NOT_FOUND', 'Objednávka nemá ověřitelnou platbu.', 409);
    store.cancelOrder(order.id, actor(req).id);
    await processor.requestRefund(intent.intent_id);
    event('order', order.id, 'owner_refund_requested', actor(req).id, { intent_id: intent.intent_id });
    res.json(orderView(store.getOrder(order.id)));
  });
  for (const [path, action] of [['resume-payment', 'resume'], ['authorize-refund', 'authorize_refund']] as const) {
    app.post(`/api/admin/orders/:id/${path}`, owner, async (req, res) => {
      if (req.body?.confirm !== true) fail('HUMAN_CONFIRMATION_REQUIRED', 'Majitel musí výslovně potvrdit tuto konkrétní platební operaci.', 403);
      const order = ownOrder(req, param(req, 'id')), intent = intentForOrder(order.id);
      if (!intent) fail('PAYMENT_NOT_FOUND', 'Objednávka nemá platební intent.', 409);
      await processor.ownerOperation(intent.intent_id, action);
      event('order', order.id, `owner_${action}`, actor(req).id, { intent_id: intent.intent_id });
      res.json(orderView(store.getOrder(order.id)));
    });
  }
  app.get('/api/admin/events', operators, (_req, res) => res.json({ events: store.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 300').all().map(value => {
    const record = value as Record<string, unknown>; return { ...record, detail: JSON.parse(String(record.data_json)) };
  }) }));
  app.post('/api/admin/reset', owner, (_req, res) => {
    store.resetLocal(() => {
      for(const table of ['handoru_operations','handoru_reply_outbox','handoru_publications','handoru_handoffs'])store.db.prepare(`DELETE FROM ${table}`).run();
      store.db.prepare('UPDATE handoru_connections SET ready_json=NULL').run();
      store.db.prepare('UPDATE handoru_relays SET probe_passed=0,probe_nonce=NULL,probe_connection=NULL,probe_at=NULL').run();
      store.db.prepare("DELETE FROM handoru_meta WHERE key='site_agent_card' OR key LIKE 'probe:%'").run();
      for (const table of ['agent_auth_access_tokens', 'agent_auth_claim_attempts', 'agent_auth_registrations', 'agent_auth_assertion_uses', 'masumi_jobs', 'agent_approvals', 'agent_mandates', 'agent_cases', 'human_checkout_authorizations', 'order_contact_snapshots', 'legacy_receipts', 'payment_workflow_errors', 'audit_rulebook_versions', 'audit_source_snapshots']) {
        if (store.db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)) store.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    res.json({ ok: true, validation: store.validateSeed() });
  });

  app.get('/api/audit/sources', auditReaders, (req, res) => res.json({ sources: registry.list(actor(req)) }));
  app.get('/api/audit/export/:id', auditReaders, (req, res) => {
    const id = param(req, 'id'), snapshot = store.auditData();
    const dataSources: Record<string, unknown> = { catalog: snapshot.catalog, calendar: { slots: snapshot.slots, bookings: snapshot.bookings, holds: snapshot.holds },
      orders: { orders: snapshot.orders, quotes: snapshot.quotes, events: snapshot.events },
      payments: { payments: snapshot.payments, intents: snapshot.payment_intents, ledger_entries: snapshot.ledger_entries },
      supply: { partners: snapshot.partners, inventory: snapshot.inventory, quotes: snapshot.supplier_quotes, purchase_orders: snapshot.purchase_orders },
      'legacy-observations': snapshot };
    if (Object.hasOwn(dataSources, id)) res.json(registry.registerSnapshot(id, dataSources[id]));
    else res.json(registry.get(id, actor(req)));
  });
  app.get('/api/suppliers/:id/catalog', auditReaders, (req, res) => res.json({ supplier_id: param(req, 'id'), items: store.inventory(param(req, 'id')), simulation: true }));
  app.get('/api/suppliers/:id/availability', auditReaders, (req, res) => res.json({ supplier_id: param(req, 'id'), inventory: store.inventory(param(req, 'id')), simulation: true }));
  app.post('/api/agent/rulebook/proposals', business, (req, res) => {
    const proposal = actor(req).business_id!=='pneu007'?handoruApi.audits(actor(req).business_id!).proposeRulebook(actor(req),req.body):rulebooks.propose(actor(req), req.body);
    event('rulebook', String(proposal.version), 'agent_proposed', actor(req).id, { version: proposal.version, status: proposal.status });
    res.status(201).json({ rulebook: proposal });
  });
  app.get('/api/agent/rulebook', business, (_req, res) => res.json({ rulebook: rulebooks.getActive() }));
  app.get('/api/agent/skill', business, (_req, res) => res.type('text/markdown').send(rulebooks.skillExport()));
  app.get('/api/admin/rulebooks', operators, (_req, res) => {
    let active = null;
    try { active = rulebooks.getActive(); } catch (error) { if (!(error instanceof BusinessError)) throw error; }
    res.json({ rulebooks: rulebooks.list(), active });
  });
  app.post('/api/admin/rulebooks/:version/activate', owner, (req, res) => {
    if (store.listPaymentIntents().some(value => value.authorization.kind === 'agent_mandate' && !['failed', 'refunded', 'seller_paid'].includes(value.state))) {
      fail('AGENT_PAYMENT_PENDING', 'Pravidla nelze změnit během nedokončeného agentického nákupu.', 409);
    }
    if(typeof req.body?.payload_hash!=='string'||req.body.payload_hash.length!==64)fail('RULEBOOK_HASH_REQUIRED','Approve the exact reviewed payload hash.',409);
    const active = rulebooks.activate(actor(req), integer(Number(param(req, 'version')), 'Verze'),req.body?.payload_hash);
    event('rulebook', String(active.version), 'human_activated', actor(req).id, { version: active.version });
    res.json({ rulebook: active });
  });
  app.get('/api/admin/rulebooks/:version/skill', owner, (req, res) => res.type('text/markdown').send(rulebooks.skillExport(Number(param(req, 'version')))));
  app.get('/api/admin/approvals', owner, (req, res) => res.json({ approvals: policy.listApprovals(actor(req)) }));
  app.post('/api/admin/approvals/:id/decide', owner, (req, res) => res.json({ approval: policy.decideApproval(actor(req), param(req, 'id'), req.body?.decision) }));
  app.get('/api/admin/mandates', auth.require('owner', 'human_customer'), (req, res) => res.json({ mandates: policy.listMandates(actor(req)) }));
  app.post('/api/admin/mandates/:id/approve', human, (req, res) => res.json({ mandate: policy.approveMandate(actor(req), param(req, 'id')) }));
  app.get('/api/agent/cases', agents, (req, res) => res.json({ cases: policy.listCases(actor(req)) }));
  app.get('/api/agent/tools', business, (_req, res) => res.json({ tools: GARAGE_TOOLS }));
  app.post('/api/agent/registry-proof', business, (req, res) => {
    const principal = actor(req);
    if (!principal.connection_id && principal.id !== businessIdentity?.id) fail('FORBIDDEN', 'Only this website\'s configured business agent can publish registry proof.', 403);
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'business_id') || !Object.hasOwn(body, 'challenge')) {
      fail('INVALID_REGISTRY_PROOF', 'Supply exactly business_id and challenge.');
    }
    const { business_id, challenge } = body as Record<string, unknown>;
    if (typeof business_id !== 'string' || business_id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(business_id)
      || typeof challenge !== 'string' || challenge.length < 32 || challenge.length > 128 || /[^A-Za-z0-9_-]/.test(challenge)) {
      fail('INVALID_REGISTRY_PROOF', 'Supply a registry UUID and a 32–128 character base64url challenge.');
    }
    store.db.transaction(() => {
      store.db.prepare(`INSERT INTO business_registry_proof VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        business_id=excluded.business_id,challenge=excluded.challenge,published_by=excluded.published_by,published_at=excluded.published_at`)
        .run(business_id, challenge, principal.id, now().toISOString());
      event('registry', business_id, 'website_proof_published', principal.id, { path: '/.well-known/business-registry-verification.json' });
    })();
    res.json({ published: true, url: `${cfg.publicUrl}/.well-known/business-registry-verification.json`, business_id });
  });
  app.get('/api/agent/reservations', business, (req, res) => {
    const fromInput = query(req, 'from'), toInput = query(req, 'to'), status = query(req, 'status');
    if ((fromInput && !Number.isFinite(Date.parse(fromInput))) || (toInput && !Number.isFinite(Date.parse(toInput)))) {
      fail('INVALID_DATE_RANGE', 'Reservation filters require valid dates.');
    }
    const from = fromInput ? new Date(fromInput).toISOString() : undefined;
    const to = toInput ? new Date(toInput).toISOString() : undefined;
    if (from && to && from >= to) fail('INVALID_DATE_RANGE', 'Reservation range must end after it starts.');
    if (status !== undefined && !['confirmed', 'cancelled', 'service_completed'].includes(status)) {
      fail('INVALID_BOOKING_STATUS', 'Use confirmed, cancelled or service_completed.');
    }
    const orderIds = new Set(policy.listCases(actor(req)).map(value => value.order_id).filter(Boolean));
    const reservations = store.calendar().filter(value => orderIds.has(value.order_id)
      && (!from || value.start_at >= from) && (!to || value.start_at < to)
      && (!status || value.status === status));
    res.json({ reservations, timezone: 'Europe/Prague', scope: 'assigned_agent_cases' });
  });
  app.post('/api/agent/cases', auth.require('customer_agent'), async (req, res) => {
    const taskId = req.body?.relay_task_id;
    if (taskId !== undefined) {
      if (typeof taskId !== 'string' || !options.validateRelayTask || !await options.validateRelayTask(actor(req), taskId)) {
        fail('RELAY_TASK_FORBIDDEN', 'The A2A task is not assigned to this customer agent.', 403);
      }
      const existing = policy.listCases(actor(req)).find(value => value.relay_task_id === taskId);
      if (existing) return void res.json({ case: existing });
    }
    res.status(201).json({ case: policy.createCase(actor(req), req.body) });
  });
  app.get('/api/agent/cases/:id', agents, (req, res) => {const c=policy.getCase(actor(req),param(req,'id'));const approval=store.db.prepare('SELECT payload_json FROM agent_approvals WHERE case_id=? AND quote_id=?').get(c.id,c.quote_id??'') as {payload_json:string}|undefined;res.json({case:c,quote:c.quote_id?store.getQuote(c.quote_id):null,approval:approval?JSON.parse(approval.payload_json):null});});
  app.post('/api/agent/mandates', auth.require('customer_agent'), (req, res) => res.status(201).json({ mandate: policy.proposeMandate(actor(req), req.body) }));
  app.get('/api/agent/mandates/:id', auth.require('customer_agent'), (req, res) => res.json({ mandate: policy.getMandate(actor(req), param(req, 'id')) }));
  app.get('/api/agent/availability', business, (req, res) => {
    rulebooks.getActive();
    res.json({ slots: store.availability({ service_id: query(req, 'service_id'), from: query(req, 'from'), to: query(req, 'to') }), timezone: 'Europe/Prague' });
  });
  app.post('/api/agent/cases/:id/quotes', business, (req, res) => {const a=actor(req),caseId=param(req,'id');const result=a.connection_id&&a.connection_id!=='compatibility-pneu007'?handoru.operation(a,req.header('idempotency-key')??'','quote.create',{case_id:caseId,...req.body},'cases.quote',()=>policy.quote(a,caseId,req.body)):policy.quote(a,caseId,req.body);res.status(201).json(result);});
  app.post('/api/agent/cases/:id/accept', auth.require('customer_agent'), (req, res) => res.json(policy.accept(actor(req), param(req, 'id'), req.body)));
  app.get('/api/agent/orders/:id', agents, (req, res) => res.json(orderView(ownOrder(req, param(req, 'id')))));
  app.post('/api/agent/orders/:id/checkout', business, async (req, res) => {
    const order = ownOrder(req, param(req, 'id'));
    const a=actor(req);
    const intent = a.connection_id?handoru.operation(a,req.header('idempotency-key')??`checkout:${order.id}`,'orders.checkout',{order_id:order.id},'orders.checkout',()=>prepareAgentCheckout(a,order)):prepareAgentCheckout(a,order);
    await processor.reconcile(intent.intent_id);
    if(a.connection_id){if(!auth.identify(req))fail('UNAUTHENTICATED','Credential was revoked during the accepted operation.',401);handoru.authorize(a,a.business_id!,'orders.checkout',true);}
    res.json({ ...orderView(store.getOrder(order.id)), intent: store.getPaymentIntent(intent.intent_id) });
  });
  app.get('/masumi/availability', (_req, res) => {
    let active = false;
    try { rulebooks.getActive(); active = true; } catch (error) { if (!(error instanceof BusinessError)) throw error; }
    const status = providerStatus();
    const available = provider.name === 'masumi' && provider.prepareJob && businessIdentity && status.configured && status.purchase_ready && active;
    res.json({ status: available ? 'available' : 'unavailable', type: 'masumi-agent',
      message: 'Purchase of a confirmed fictional reservation; does not imply physical tyre service delivery.', simulation: provider.name === 'local_demo' });
  });
  app.get('/masumi/input_schema', (_req, res) => res.json({ input_data: [
    { id: 'order_id', type: 'string', name: 'Previously accepted order, already within a human-approved customer mandate' },
  ], identifier_constraint: 'This payment-service version accepts even-length lowercase hexadecimal purchaser identifiers of 14–26 characters.' }));
  app.post('/masumi/start_job', auth.require('customer_agent'), async (req, res) => {
    if (provider.name !== 'masumi' || !provider.prepareJob || !currentBusinessIdentity()) fail('MASUMI_JOB_UNAVAILABLE', 'Skutečný Masumi seller job provider není připojen.', 503);
    const input = req.body?.input_data, identifier = req.body?.identifier_from_purchaser;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.order_id !== 'string'
      || typeof identifier !== 'string' || !/^(?:[a-f0-9]{2}){7,13}$/.test(identifier)) fail('INVALID_JOB_INPUT', 'Job vyžaduje přijatou order_id a platný purchaser identifier.');
    const order = ownOrder(req, input.order_id);
    // The schema permits exactly one string field, so this is its RFC 8785 representation.
    const canonical = JSON.stringify({ order_id: input.order_id });
    const intent = prepareAgentCheckout(currentBusinessIdentity()??fail('BUSINESS_AGENT_UNAVAILABLE','No active connection.',409), order, { purchaser_identifier: identifier, input_hash: createHash('sha256').update(`${identifier};${canonical}`).digest('hex') });
    const oldJob = store.db.prepare('SELECT job_json FROM masumi_jobs WHERE id=?').get(intent.intent_id) as { job_json: string } | undefined;
    if (oldJob) return void res.json(JSON.parse(oldJob.job_json));
    // Fence before preparing the external seller request. Polling then only observes; it never charges the buyer.
    store.markPurchaseRequested(intent.intent_id);
    let preparing = jobPreparations.get(intent.intent_id);
    if (!preparing) {
      const work = provider.prepareJob(intent).finally(() => { if (jobPreparations.get(intent.intent_id) === work) jobPreparations.delete(intent.intent_id); });
      jobPreparations.set(intent.intent_id, work); preparing = work;
    }
    const job = await preparing;
    if (job.id !== intent.intent_id || job.identifierFromPurchaser !== identifier || job.input_hash !== intent.input_hash) fail('PAYMENT_IDENTITY_MISMATCH', 'Seller job neodpovídá neměnnému intentu.', 502);
    store.db.prepare('INSERT OR IGNORE INTO masumi_jobs VALUES(?,?,?,?,?)').run(job.id, order.customer_id, identifier, JSON.stringify(job), canonical);
    event('payment_intent', intent.intent_id, 'seller_job_prepared', actor(req).id, { job_id: job.id, simulation: job.simulation ?? false });
    res.json(job);
  });
  app.get('/masumi/status', auth.require('customer_agent', 'business_agent', 'owner'), async (req, res) => {
    const id = query(req, 'job_id');
    if (!id) fail('INVALID_JOB_ID', 'job_id je povinné.');
    const intent = store.getPaymentIntent(id);
    ownOrder(req, intent.order_id);
    if (!store.db.prepare('SELECT id FROM masumi_jobs WHERE id=?').get(id)) fail('JOB_NOT_FOUND', 'Neznámý job.', 404);
    await processor.reconcile(id);
    const current = store.getPaymentIntent(id), receipt = processor.getReceipt(id), order = store.getOrder(current.order_id);
    const status = ['failed', 'refunded'].includes(current.state) || ['cancel_requested', 'cancelled', 'refund_pending'].includes(order.status) ? 'failed'
      : receipt && ['escrow_funded', 'result_submitted', 'seller_paid'].includes(current.state) ? 'completed' : 'awaiting_payment';
    const result = status === 'completed' ? processor.getResult(id) : undefined;
    res.json({ status, input_hash: current.input_hash, ...(result === undefined ? {} : {
      result, output_hash: createHash('sha256').update(`${current.identifier_from_purchaser};${result}`).digest('hex'),
    }), payment_state: current.state, simulation: provider.name === 'local_demo' });
  });
  app.get('/api/owner/revenue', auth.require('owner', 'owner_agent'), (req, res) => {
    const day = query(req, 'date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('INVALID_DATE', 'Použijte datum YYYY-MM-DD.');
    const records = store.db.prepare('SELECT * FROM payments').all() as Array<{ origin: string; state: string; amount_minor: number; recorded_at: string }>;
    const matches = records.filter(value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(value.recorded_at)) === day);
    const sum = (origin: string, states?: string[]) => matches.filter(value => value.origin === origin && (!states || states.includes(value.state))).reduce((total, value) => total + value.amount_minor, 0);
    res.json({ date: day, timezone: 'Europe/Prague', metric: 'synthetic business amounts by funding receipt date, separately classified from provider settlement', currency: 'CZK',
      fixture_minor: sum('fixture'), local_demo_minor: sum('local_demo', ['escrow_funded', 'result_submitted', 'seller_paid']),
      live_escrow_minor: sum('live_preprod', ['escrow_funded', 'result_submitted']), live_settled_minor: sum('live_preprod', ['seller_paid']),
      actual_czk_revenue: false, recipient: actor(req).id });
  });
  app.get('/api/agent/profile', (_req, res) => {
    let active = false;
    try { rulebooks.getActive(); active = true; } catch (error) { if (!(error instanceof BusinessError)) throw error; }
    res.json({ name: 'Pneu 007', fictional: true, location: loadProfile('pneu007').location, active, transport_configured: Boolean(options.agentCard), payment: providerStatus(),
      payment_api: { standard: 'MIP-003', hashing: 'MIP-004', base_url: `${cfg.publicUrl}/masumi`,
        availability: '/masumi/availability', input_schema: '/masumi/input_schema', start_job: '/masumi/start_job', status: '/masumi/status',
        authentication: 'Bearer token for the assigned agent identity; job creation requires a customer agent and an approved order.' },
      skills: active ? ['tyre_change', 'wheel_swap'] : [], agent_card_url: '/.well-known/agent-card.json' });
  });
  app.get('/.well-known/business-registry-verification.json', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const proof = store.db.prepare('SELECT business_id,challenge FROM business_registry_proof WHERE id=1').get();
    if (!proof) return void res.status(404).json({ error: 'REGISTRY_PROOF_NOT_PUBLISHED' });
    res.json(proof);
  });
  app.get('/.well-known/agent-card.json', (_req, res) => {
    const b=handoru.installation();if(b)rulebooks.useBusiness(b.id,{genericEvidence:b.id!=='pneu007'});
    const published=store.db.prepare("SELECT value FROM handoru_meta WHERE key='site_agent_card'").get() as {value:string}|undefined;
    if(b&&(!b.active_connection_id||(!published&&b.id!=='pneu007')))return void res.set('Cache-Control','no-store').status(503).json({error:'AGENT_NOT_PUBLISHED'});
    if(published){try{rulebooks.getActive();}catch{return void res.status(503).json({error:'AGENT_INACTIVE'});}const site=JSON.parse(published.value);if(site.rulebook_hash!==rulebooks.getActive().payload_hash)return void res.status(503).json({error:'PUBLICATION_STALE'});const card=site.descriptor;const etag='"'+createHash('sha256').update(JSON.stringify(card)).digest('hex')+'"';return void res.set('Cache-Control','no-cache, max-age=0, must-revalidate').set('ETag',etag).json(card);}
    try { rulebooks.getActive(); } catch (error) { if (!(error instanceof BusinessError)) throw error; return void res.status(503).json({ error: 'AGENT_INACTIVE', message: 'Majitel zatím neaktivoval aktuální auditovaný rulebook.' }); }
    if (!options.agentCard) return void res.status(503).json({ error: 'A2A_NOT_CONFIGURED', message: 'Spusťte sjednocený server pro A2A komunikaci.' });
    res.set('Cache-Control', 'no-store').json(options.agentCard());
  });
  app.get(['/cli/handle.mjs','/cli/handoru.mjs'],(_req,res)=>res.type('text/javascript').sendFile(join(repoRoot,'packages/agent-client/dist/handle.mjs')));
  app.get('/cli/garage.mjs', (_req, res) => {
    const path = join(repoRoot, 'packages/agent-client/dist/garage.mjs');
    if (!existsSync(path)) return void res.status(404).json({ error: 'CLI_NOT_BUILT' });
    res.type('text/javascript').sendFile(path);
  });
  app.get('/cli/customer.mjs', (_req, res) => res.type('text/javascript').sendFile(join(repoRoot, 'packages/agent-client/dist/customer.mjs')));
  app.get('/skills/a2a-customer-booking/SKILL.md', (_req, res) => res.type('text/markdown').sendFile(join(repoRoot, 'skills/a2a-customer-booking/SKILL.md')));
  app.get('/cli/discover-sites.mjs', (_req, res) => {
    const path = join(repoRoot, 'packages/agent-client/dist/discover-sites.mjs');
    if (!existsSync(path)) return void res.status(404).json({ error: 'CLI_NOT_BUILT' });
    res.type('text/javascript').sendFile(path);
  });
  app.get('/skills/a2a-website-discovery/SKILL.md', (_req, res) => {
    res.type('text/markdown').sendFile(join(repoRoot, 'skills/a2a-website-discovery/SKILL.md'));
  });
  app.get('/skills/pneu007-business/SKILL.md', (_req, res) => {
    res.type('text/markdown').sendFile(join(repoRoot, 'skills/pneu007-business/SKILL.md'));
  });
  app.get('/skills/business-registry/SKILL.md', (_req, res) => res.type('text/markdown').sendFile(join(repoRoot, 'skills/business-registry/SKILL.md')));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Neznámá operace API.' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof BusinessError) {
      if (error.status === 401) res.set('WWW-Authenticate', `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`);
      return void res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    const syntax = error instanceof SyntaxError;
    res.status(syntax ? 400 : 500).json({ error: { code: syntax ? 'INVALID_JSON' : 'INTERNAL_ERROR', message: syntax ? 'Neplatný JSON požadavku.' : 'Operaci se nepodařilo dokončit.' } });
  });
  const pages: Record<string, string> = { '/': 'index.html', '/kalkulator': 'kalkulator.html', '/kontakt': 'kontakt.html', '/podminky': 'podminky.html',
    '/pro-agenty': 'pro-agenty.html', '/objednavka': 'objednavka.html', '/admin': 'console.html', '/handle': 'handoru.html', '/handoru': 'handoru.html', '/agent/claim': 'console.html', '/agent/access': 'console.html', '/agent/mandates': 'console.html' };
  for (const extension of ['css','js']) app.get(`/handle.${extension}`,(_req,res)=>res.sendFile(join(publicDirectory,`handoru.${extension}`)));
  for (const [route, file] of Object.entries(pages)) app.get(route, (_req, res) => {
    if (route.startsWith('/agent/')) res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    if(route==='/'&&handoru.installation()?.active_connection_id&&store.db.prepare("SELECT 1 FROM handoru_meta WHERE key='site_agent_card'").get()) {
      try{const pub=JSON.parse((store.db.prepare("SELECT value FROM handoru_meta WHERE key='site_agent_card'").get() as {value:string}).value);if(pub.rulebook_hash!==rulebooks.getActive().payload_hash)throw Error('stale');return void res.type('html').send(readFileSync(join(publicDirectory,file),'utf8').replace('</footer>','<a class="handoru-agent-card-link" href="/.well-known/agent-card.json">Pro agenty · Agent Card</a></footer>'));}catch{}
    }
    res.sendFile(join(publicDirectory, file));
  });
  app.get('/objednavka/:id', (_req, res) => res.sendFile(join(publicDirectory, 'objednavka.html')));
  app.use(express.static(publicDirectory, { index: false, dotfiles: 'deny' }));
  processor.start(cfg.reconciliationMs);
  stripe.startBackground(cfg.reconciliationMs);
  return { app, store, policy, rulebooks, registry, processor, stripe, auth, agentAuth, handoru,
    close: async () => { await processor.close(); await stripe.close(); store.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadLegacyConfig(), system = createLegacy(cfg);
  const server = system.app.listen(cfg.port, cfg.host, (error?: Error) => {
    if (error) { console.error(`Server se nepodařilo spustit: ${error.message}`); void system.close(); process.exitCode = 1; return; }
    console.log(`Pneu 007 legacy business: ${cfg.publicUrl}`);
    console.log(`Provider: ${system.processor.provider.name}; no active rulebook is seeded.`);
    console.log('Local-only access credentials: data/legacy-access.json (never published).');
  });
  const stop = () => { server.close(() => { void system.close().then(() => { process.exitCode = 0; }); }); server.closeAllConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
