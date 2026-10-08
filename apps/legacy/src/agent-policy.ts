import { createHash, randomUUID } from 'node:crypto';
import { BusinessError, type Actor, type ServiceSpec, type PurchaseAuthorization } from '../../../packages/contracts/index.js';
import { LegacyStore, validateServiceSpec, type Quote, type Order, type Slot } from '../../../packages/demo-garage/index.js';
import { RulebookManager, type RulebookVersion } from '../../../packages/audit/index.js';

export interface AgentCase {
  id: string; customer_id: string; customer_agent_id: string; business_actor_id: string;
  service_spec: ServiceSpec; relay_task_id: string | null;
  status: 'open' | 'quoted' | 'awaiting_owner' | 'recommended' | 'accepted';
  quote_id: string | null; quote_version: number | null; quote_hash: string | null;
  rulebook_version: number | null; mandate_id: string | null; order_id: string | null;
  accepted_by: string | null; accepted_at: string | null; created_at: string; updated_at: string;
}
export interface MandateInput {
  case_id: string; mode: 'recommend' | 'book'; service_spec: ServiceSpec;
  max_total_minor: number; max_deposit_minor: number; payment_mode: 'deposit' | 'full';
  latest_service_end: string; expires_at: string; allow_extras: false; currency: 'CZK';
  network: 'local' | 'Preprod'; asset: 'lovelace'; max_asset_quantity: string;
  max_network_fee: string; mapping_version: string; seller_id: string;
}
export interface AgentMandate extends MandateInput {
  id: string; customer_id: string; proposed_by: string; status: 'pending' | 'approved';
  approved_by: string | null; approved_at: string | null; created_at: string;
}
export interface AgentApproval {
  id: string; case_id: string; quote_id: string; quote_version: number; quote_hash: string;
  rulebook_version: number; status: 'pending' | 'approved' | 'rejected';
  requested_by: string; decided_by: string | null; decided_at: string | null; created_at: string;
}
export interface CheckoutMapping {
  network: 'local' | 'Preprod'; seller_id: string; asset: string; asset_quantity: string;
  max_network_fee: string; mapping_version: string; provider: 'local_demo' | 'masumi';
}
const newId = (kind: string) => `${kind}-${randomUUID()}`;
function fail(code: string, message: string, status = 400): never { throw new BusinessError(code, message, status); }
function role(actor: Actor, expected: Actor['role']) { if (actor.role !== expected) fail('FORBIDDEN', `Requires authenticated ${expected} identity`, 403); }
function scalar(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('INVALID_INPUT', `Invalid ${label}`);
}
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('INVALID_INPUT', 'Missing or unsupported input fields');
}
function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('INVALID_INPUT', `${label} must be a nonnegative integer`);
}
function quantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || value.length > 60 || !/^(0|[1-9][0-9]*)$/.test(value)) fail('INVALID_INPUT', `${label} must be an integer string in smallest units`);
  return BigInt(value);
}
function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_INPUT', `Invalid RFC3339 ${label}`);
  return new Date(value).toISOString();
}
function spec(value: ServiceSpec): ServiceSpec {
  object(value, ['service_id', 'vehicle_type', 'wheel_size_inches', 'rim_type', 'runflat', 'tpms', 'wheel_count']);
  validateServiceSpec(value); return {...value};
}
function sameSpec(a: ServiceSpec, b: ServiceSpec): boolean {
  return a.service_id === b.service_id && a.vehicle_type === b.vehicle_type && a.wheel_size_inches === b.wheel_size_inches && a.rim_type === b.rim_type && a.runflat === b.runflat && a.tpms === b.tpms && a.wheel_count === b.wheel_count;
}
function quoteHash(q: Quote): string {
  return createHash('sha256').update(JSON.stringify({id:q.id,version:q.version,customer_id:q.customer_id,slot_id:q.slot_id,price:q.price,rulebook_version:q.rulebook_version,expires_at:q.expires_at,requires_owner_approval:q.requires_owner_approval})).digest('hex');
}
const mandateFields = ['case_id','mode','service_spec','max_total_minor','max_deposit_minor','payment_mode','latest_service_end','expires_at','allow_extras','currency','network','asset','max_asset_quantity','max_network_fee','mapping_version','seller_id'] as const;

/** A trusted adapter policy: roles come from authenticated server principals, never request bodies. */
export class AgentPolicy {
  readonly now: () => Date;
  readonly businessActorId: string;
  constructor(readonly store: LegacyStore, readonly rulebooks: RulebookManager, options: {now?:()=>Date;businessActorId?:string} = {}) {
    this.now = options.now ?? (()=>new Date()); this.businessActorId = options.businessActorId ?? 'garage-demo';
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_cases (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), customer_agent_id TEXT NOT NULL,
      business_actor_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
      quote_id TEXT REFERENCES quotes(id), mandate_id TEXT, order_id TEXT UNIQUE REFERENCES orders(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS agent_mandates (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES agent_cases(id), customer_id TEXT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL, payload_json TEXT NOT NULL, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES agent_cases(id), quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
      status TEXT NOT NULL, payload_json TEXT NOT NULL, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
    );`);
  }
  private time() { return this.now().toISOString(); }
  private event(entity: string, id: string, kind: string, actor: Actor, data: unknown) {
    this.store.db.prepare('INSERT INTO audit_events(entity_type,entity_id,event_type,actor_id,data_json,created_at) VALUES(?,?,?,?,?,?)').run(entity,id,kind,actor.id,JSON.stringify(data),this.time());
  }
  private business(actor: Actor) { role(actor,'business_agent'); if (actor.id !== this.businessActorId) fail('FORBIDDEN','Business agent is not assigned to this business',403); }
  private customer(actor: Actor): string {
    if (!actor.customer_id || !this.store.db.prepare('SELECT id FROM customers WHERE id=?').get(actor.customer_id)) fail('FORBIDDEN','Actor has no recognized customer assignment',403);
    return actor.customer_id;
  }
  private caseById(id: string): AgentCase {
    scalar(id,'case_id'); const row=this.store.db.prepare('SELECT payload_json FROM agent_cases WHERE id=?').get(id) as {payload_json:string}|undefined;
    if (!row) fail('CASE_NOT_FOUND','Unknown agent case',404); return JSON.parse(row.payload_json) as AgentCase;
  }
  private saveCase(c: AgentCase) {
    this.store.db.prepare('UPDATE agent_cases SET status=?,payload_json=?,quote_id=?,mandate_id=?,order_id=?,updated_at=? WHERE id=?').run(c.status,JSON.stringify(c),c.quote_id,c.mandate_id,c.order_id,c.updated_at,c.id);
  }
  private checkAccess(actor: Actor, c: AgentCase) {
    if (actor.role === 'owner') return;
    if (actor.role === 'business_agent') { this.business(actor); if (c.business_actor_id === actor.id) return; }
    if (['customer_agent','human_customer'].includes(actor.role) && this.customer(actor) === c.customer_id && (actor.role === 'human_customer' || actor.id === c.customer_agent_id)) return;
    fail('FORBIDDEN','Case belongs to another principal',403);
  }
  createCase(actor: Actor, input: {service_spec:ServiceSpec;relay_task_id?:string}): AgentCase {
    role(actor,'customer_agent');object(input,['service_spec','relay_task_id'],['service_spec']);
    const customer_id=this.customer(actor), service_spec=spec(input.service_spec);
    if (input.relay_task_id !== undefined) scalar(input.relay_task_id,'relay_task_id');
    const now=this.time();const c:AgentCase={id:newId('case'),customer_id,customer_agent_id:actor.id,business_actor_id:this.businessActorId,service_spec,relay_task_id:input.relay_task_id??null,status:'open',quote_id:null,quote_version:null,quote_hash:null,rulebook_version:null,mandate_id:null,order_id:null,accepted_by:null,accepted_at:null,created_at:now,updated_at:now};
    this.store.db.transaction(()=>{
      this.store.db.prepare('INSERT INTO agent_cases(id,customer_id,customer_agent_id,business_actor_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(c.id,customer_id,actor.id,this.businessActorId,c.status,JSON.stringify(c),now,now);
      this.event('agent_case',c.id,'created',actor,{service_spec,relay_task_id:c.relay_task_id});
    })();return c;
  }
  getCase(actor: Actor, id: string): AgentCase { const c=this.caseById(id);this.checkAccess(actor,c);return c; }
  listCases(actor: Actor): AgentCase[] {
    if (actor.role === 'business_agent') this.business(actor);
    if (!['owner','business_agent','customer_agent','human_customer'].includes(actor.role)) fail('FORBIDDEN','Cases are restricted',403);
    const rows=this.store.db.prepare('SELECT payload_json FROM agent_cases ORDER BY created_at DESC').all() as {payload_json:string}[];
    return rows.map(r=>JSON.parse(r.payload_json) as AgentCase).filter(c=>actor.role==='owner'||(actor.role==='business_agent'?c.business_actor_id===actor.id:c.customer_id===this.customer(actor)&&(actor.role==='human_customer'||c.customer_agent_id===actor.id)));
  }
  private mandateById(id: string): AgentMandate {
    scalar(id,'mandate_id');const row=this.store.db.prepare('SELECT payload_json FROM agent_mandates WHERE id=?').get(id) as {payload_json:string}|undefined;
    if (!row) fail('MANDATE_NOT_FOUND','Unknown mandate',404);return JSON.parse(row.payload_json) as AgentMandate;
  }
  proposeMandate(actor: Actor, input: MandateInput): AgentMandate {
    role(actor,'customer_agent');object(input,mandateFields);const c=this.getCase(actor,input.case_id);
    if (c.status==='accepted') fail('CASE_ALREADY_ACCEPTED','Accepted case mandate cannot be expanded',409);
    const service_spec=spec(input.service_spec);if (!sameSpec(service_spec,c.service_spec)) fail('MANDATE_SPEC_MISMATCH','Mandate service differs from case',403);
    if (!['recommend','book'].includes(input.mode)||!['deposit','full'].includes(input.payment_mode)||input.allow_extras!==false||input.currency!=='CZK'||!['Preprod','local'].includes(input.network)||input.asset!=='lovelace') fail('INVALID_MANDATE','Unsupported mode, payment scope, currency or extras');
    integer(input.max_total_minor,'max_total_minor');integer(input.max_deposit_minor,'max_deposit_minor');
    quantity(input.max_asset_quantity,'max_asset_quantity');quantity(input.max_network_fee,'max_network_fee');
    scalar(input.mapping_version,'mapping_version');scalar(input.seller_id,'seller_id');
    const expires_at=date(input.expires_at,'expires_at'),latest_service_end=date(input.latest_service_end,'latest_service_end');
    if (expires_at<=this.time()||latest_service_end<=this.time()) fail('MANDATE_EXPIRED','Mandate validity and service deadline must be future dates',409);
    const m:AgentMandate={...input,service_spec,expires_at,latest_service_end,id:newId('mandate'),customer_id:c.customer_id,proposed_by:actor.id,status:'pending',approved_by:null,approved_at:null,created_at:this.time()};
    this.store.db.transaction(()=>{
      this.store.db.prepare('INSERT INTO agent_mandates(id,case_id,customer_id,status,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(m.id,c.id,m.customer_id,m.status,JSON.stringify(m),m.created_at);
      this.event('agent_mandate',m.id,'proposed',actor,{case_id:c.id,mode:m.mode});
    })();return m;
  }
  getMandate(actor: Actor, id: string): AgentMandate {
    if (!['owner','customer_agent','human_customer'].includes(actor.role)) fail('FORBIDDEN','Mandates are customer-private',403);
    const m=this.mandateById(id);this.checkAccess(actor,this.caseById(m.case_id));return m;
  }
  listMandates(actor: Actor): AgentMandate[] {
    if (!['owner','customer_agent','human_customer'].includes(actor.role)) fail('FORBIDDEN','Mandates are customer-private',403);
    return (this.store.db.prepare('SELECT payload_json FROM agent_mandates ORDER BY created_at DESC').all() as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json) as AgentMandate).filter(m=>actor.role==='owner'||m.customer_id===this.customer(actor)&&(actor.role==='human_customer'||m.proposed_by===actor.id));
  }
  approveMandate(actor: Actor, id: string): AgentMandate {
    role(actor,'human_customer');const m=this.getMandate(actor,id);if (m.expires_at<=this.time()) fail('MANDATE_EXPIRED','Cannot approve an expired mandate',409);
    if (m.status==='approved') return m;
    const next:AgentMandate={...m,status:'approved',approved_by:actor.id,approved_at:this.time()};
    this.store.db.transaction(()=>{
      this.store.db.prepare('UPDATE agent_mandates SET status=?,payload_json=?,approved_by=?,approved_at=? WHERE id=?').run(next.status,JSON.stringify(next),actor.id,next.approved_at,id);
      this.event('agent_mandate',id,'human_approved',actor,{case_id:m.case_id});
    })();return next;
  }
  private approvalById(id: string): AgentApproval {
    scalar(id,'approval_id');const row=this.store.db.prepare('SELECT payload_json FROM agent_approvals WHERE id=?').get(id) as {payload_json:string}|undefined;
    if (!row) fail('APPROVAL_NOT_FOUND','Unknown approval request',404);return JSON.parse(row.payload_json) as AgentApproval;
  }
  quote(actor: Actor, caseId: string, input: {slot_id:string;discount_bps:number}): {case:AgentCase;quote:Quote;approval?:AgentApproval} {
    this.business(actor);object(input,['slot_id','discount_bps']);scalar(input.slot_id,'slot_id');integer(input.discount_bps,'discount_bps');
    const c=this.getCase(actor,caseId);if (c.status==='accepted') fail('CASE_ALREADY_ACCEPTED','Accepted case cannot be requoted',409);
    const active=this.rulebooks.assertService(c.service_spec.service_id),p=active.params;
    if (input.discount_bps>p.hard_discount_limit_bps||input.discount_bps>p.owner_approval_limit_bps) fail('DISCOUNT_FORBIDDEN','Discount exceeds human-approved hard ceiling',403);
    const needsOwner=input.discount_bps>p.auto_discount_bps;
    return this.store.db.transaction(()=>{
      const q=this.store.createQuote({customer_id:c.customer_id,service_spec:c.service_spec,slot_id:input.slot_id,discount_bps:input.discount_bps,rulebook_version:active.version,requires_owner_approval:needsOwner,offer_ttl_seconds:p.offer_ttl_seconds});
      const next:AgentCase={...c,status:needsOwner?'awaiting_owner':'quoted',quote_id:q.id,quote_version:q.version,quote_hash:quoteHash(q),rulebook_version:active.version,updated_at:this.time()};this.saveCase(next);
      let approval:AgentApproval|undefined;
      if (needsOwner) {
        approval={id:newId('approval'),case_id:c.id,quote_id:q.id,quote_version:q.version,quote_hash:quoteHash(q),rulebook_version:active.version,status:'pending',requested_by:actor.id,decided_by:null,decided_at:null,created_at:this.time()};
        this.store.db.prepare('INSERT INTO agent_approvals(id,case_id,quote_id,status,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(approval.id,c.id,q.id,approval.status,JSON.stringify(approval),approval.created_at);
        this.event('agent_approval',approval.id,'requested',actor,{case_id:c.id,quote_id:q.id,quote_version:q.version});
      }
      this.event('agent_case',c.id,'quoted',actor,{quote_id:q.id,rulebook_version:active.version});return {case:next,quote:q,...(approval?{approval}:{})};
    })();
  }
  listApprovals(actor: Actor): AgentApproval[] {
    role(actor,'owner');return (this.store.db.prepare('SELECT payload_json FROM agent_approvals ORDER BY created_at DESC').all() as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json) as AgentApproval);
  }
  private verifyQuote(c: AgentCase, q: Quote, active: RulebookVersion) {
    if (q.id!==c.quote_id||q.version!==c.quote_version||quoteHash(q)!==c.quote_hash||q.rulebook_version!==active.version||c.rulebook_version!==active.version||q.customer_id!==c.customer_id||!sameSpec(q.price.service_spec,c.service_spec)) fail('QUOTE_BINDING_MISMATCH','Quote or rulebook changed; obtain a new offer and acceptance',409);
    if (q.expires_at<=this.time()) fail('QUOTE_EXPIRED','Quote expired',409);
  }
  decideApproval(actor: Actor, id: string, decision: 'approved'|'rejected'): AgentApproval {
    role(actor,'owner');if (!['approved','rejected'].includes(decision)) fail('INVALID_INPUT','Invalid approval decision');
    const a=this.approvalById(id),c=this.getCase(actor,a.case_id),q=this.store.getQuote(a.quote_id),active=this.rulebooks.getActive();this.verifyQuote(c,q,active);
    if (a.quote_version!==q.version||a.quote_hash!==quoteHash(q)||a.rulebook_version!==active.version) fail('APPROVAL_BINDING_MISMATCH','Approval is not bound to current immutable quote',409);
    if (a.status!=='pending') {if (a.status===decision) return a;fail('APPROVAL_ALREADY_DECIDED','Approval decision is immutable',409);}
    const next:AgentApproval={...a,status:decision,decided_by:actor.id,decided_at:this.time()};
    this.store.db.transaction(()=>{
      if (decision==='approved') {this.rulebooks.assertDiscount(q.price.discount_bps,{ownerApproved:true});this.store.approveQuote(q.id,actor.id);}
      this.store.db.prepare('UPDATE agent_approvals SET status=?,payload_json=?,decided_by=?,decided_at=? WHERE id=?').run(decision,JSON.stringify(next),actor.id,next.decided_at,id);
      this.saveCase({...c,status:decision==='approved'?'quoted':'awaiting_owner',updated_at:this.time()});
      this.event('agent_approval',id,decision,actor,{quote_id:q.id,quote_version:q.version});
    })();return next;
  }
  private verifyDiscount(q: Quote) {
    if (q.requires_owner_approval) {
      const row=this.store.db.prepare('SELECT payload_json FROM agent_approvals WHERE quote_id=?').get(q.id) as {payload_json:string}|undefined;
      const a=row?JSON.parse(row.payload_json) as AgentApproval:undefined;
      if (!a||a.status!=='approved'||!a.decided_by||q.approved_by!==a.decided_by||a.quote_version!==q.version||a.quote_hash!==quoteHash(q)||a.rulebook_version!==q.rulebook_version) fail('OWNER_APPROVAL_REQUIRED','Quote has no valid stored owner decision',403);
    }
    this.rulebooks.assertDiscount(q.price.discount_bps,{ownerApproved:q.requires_owner_approval&&!!q.approved_by});
  }
  private verifyMandate(c: AgentCase, q: Quote, m: AgentMandate, active: RulebookVersion) {
    if (m.status!=='approved'||!m.approved_by||!m.approved_at) fail('MANDATE_APPROVAL_REQUIRED','Customer must approve mandate in human UI',403);
    if (m.case_id!==c.id||m.customer_id!==c.customer_id||m.proposed_by!==c.customer_agent_id||!sameSpec(m.service_spec,c.service_spec)||m.allow_extras||m.currency!==q.price.currency) fail('MANDATE_BINDING_MISMATCH','Mandate differs from accepted case or service',403);
    if (m.expires_at<=this.time()) fail('MANDATE_EXPIRED','Customer mandate expired',409);
    const slot=this.store.db.prepare('SELECT * FROM calendar_slots WHERE id=?').get(q.slot_id) as Slot|undefined;
    if (!slot||slot.end_at>m.latest_service_end) fail('MANDATE_SERVICE_DEADLINE','Service exceeds customer deadline',403);
    if (q.price.total_minor>m.max_total_minor||(m.payment_mode==='deposit'&&active.params.deposit_minor>m.max_deposit_minor)) fail('MANDATE_LIMIT','Price or deposit exceeds approved customer mandate',403);
    if (m.network!==active.params.network||m.asset!==active.params.asset) fail('MANDATE_PAYMENT_SCOPE','Mandate payment scope differs from active policy',403);
    if (!active.params.allowed_services.includes(c.service_spec.service_id)) fail('SERVICE_FORBIDDEN','Service is outside approved scope',403);
  }
  accept(actor: Actor, caseId: string, input: {quote_id:string;mandate_id:string}): {case:AgentCase;status:'recommended'|'accepted';quote:Quote;order?:Order} {
    role(actor,'customer_agent');object(input,['quote_id','mandate_id']);scalar(input.quote_id,'quote_id');scalar(input.mandate_id,'mandate_id');
    const c=this.getCase(actor,caseId),q=this.store.getQuote(input.quote_id),active=this.rulebooks.getActive();this.verifyQuote(c,q,active);this.verifyDiscount(q);
    const m=this.getMandate(actor,input.mandate_id);this.verifyMandate(c,q,m,active);
    if (c.status==='accepted') {
      if (c.mandate_id!==m.id||c.accepted_by!==actor.id||!c.order_id) fail('CASE_ALREADY_ACCEPTED','Accepted case cannot change mandate or identity',409);
      return {case:c,status:'accepted',quote:q,order:this.store.getOrder(c.order_id)};
    }
    return this.store.db.transaction(()=>{
      const order=m.mode==='book'?this.store.createOrder(q.id):undefined;
      const next:AgentCase={...c,status:order?'accepted':'recommended',mandate_id:m.id,order_id:order?.id??null,accepted_by:actor.id,accepted_at:this.time(),updated_at:this.time()};this.saveCase(next);
      this.event('agent_case',c.id,order?'customer_accepted':'customer_recommended',actor,{quote_id:q.id,mandate_id:m.id,order_id:order?.id??null});
      return {case:next,status:order?'accepted' as const:'recommended' as const,quote:q,...(order?{order}:{})};
    })();
  }
  authorizationForCheckout(actor: Actor, orderId: string, mapping: CheckoutMapping): PurchaseAuthorization {
    this.business(actor);object(mapping,['network','seller_id','asset','asset_quantity','max_network_fee','mapping_version','provider']);
    scalar(orderId,'order_id');for (const key of ['seller_id','asset','mapping_version'] as const) scalar(mapping[key],key);
    const row=this.store.db.prepare('SELECT payload_json FROM agent_cases WHERE order_id=?').get(orderId) as {payload_json:string}|undefined;
    if (!row) fail('ACCEPTANCE_REQUIRED','Agent checkout requires a stored customer acceptance',403);
    const c=JSON.parse(row.payload_json) as AgentCase;this.checkAccess(actor,c);
    if (c.status!=='accepted'||!c.accepted_by||c.accepted_by!==c.customer_agent_id||!c.mandate_id) fail('ACCEPTANCE_REQUIRED','No immutable customer-agent acceptance',403);
    const order=this.store.getOrder(orderId),q=this.store.getQuote(order.quote_id),active=this.rulebooks.getActive();this.verifyQuote(c,q,active);this.verifyDiscount(q);
    const m=this.mandateById(c.mandate_id);this.verifyMandate(c,q,m,active);
    if (m.mode!=='book'||order.customer_id!==m.customer_id) fail('PURCHASE_FORBIDDEN','Recommendation mandate cannot authorize checkout',403);
    this.rulebooks.assertPayment(mapping.provider,mapping.network,mapping.asset);
    const amount=quantity(mapping.asset_quantity,'asset_quantity'),fee=quantity(mapping.max_network_fee,'max_network_fee');
    if (mapping.network!==m.network||mapping.asset!==m.asset||mapping.seller_id!==m.seller_id||mapping.mapping_version!==m.mapping_version||amount>quantity(m.max_asset_quantity,'max_asset_quantity')||fee>quantity(m.max_network_fee,'max_network_fee')) fail('MANDATE_PAYMENT_LIMIT','Payment mapping, amount, fee or recipient exceeds mandate',403);
    const businessAmount=m.payment_mode==='deposit'?active.params.deposit_minor:q.price.total_minor;
    if (amount!==BigInt(businessAmount)*100n) fail('PAYMENT_MAPPING_MISMATCH','Immutable demo CZK-to-testnet mapping does not match authorized amount',403);
    return {kind:'agent_mandate',actor_id:c.accepted_by,customer_id:m.customer_id,quote_id:q.id,quote_version:q.version,payment_mode:m.payment_mode,max_total_minor:m.max_total_minor,max_deposit_minor:m.max_deposit_minor,network:m.network,seller_id:m.seller_id,asset:m.asset,asset_quantity:mapping.asset_quantity,max_network_fee:mapping.max_network_fee,mapping_version:m.mapping_version,mandate_id:m.id,rulebook_version:active.version,approved_at:m.approved_at!};
  }
}
