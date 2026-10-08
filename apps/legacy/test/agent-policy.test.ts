import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { RulebookManager, SourceRegistry, type RulebookProposal, type Citation } from '../../../packages/audit/index.js';
import type { Actor, ServiceSpec } from '../../../packages/contracts/index.js';
import { AgentPolicy, type MandateInput, type CheckoutMapping } from '../src/agent-policy.js';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const business:Actor={id:'garage-demo',role:'business_agent'};
const owner:Actor={id:'staff-owner',role:'owner'};
const customer:Actor={id:'customer-agent-a',role:'customer_agent',customer_id:'customer-001'};
const customerB:Actor={id:'customer-agent-b',role:'customer_agent',customer_id:'customer-002'};
const human:Actor={id:'human-customer-a',role:'human_customer',customer_id:'customer-001'};
const humanB:Actor={id:'human-customer-b',role:'human_customer',customer_id:'customer-002'};
const service:ServiceSpec={service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4};
function setup() {
  let time=new Date('2026-10-08T08:00:00.000Z');const now=()=>time;
  const store=new LegacyStore(':memory:',{now});const dir=mkdtempSync(resolve(tmpdir(),'pneu-policy-test-'));
  mkdirSync(resolve(dir,'fixtures'),{recursive:true});cpSync(resolve(repoRoot,'fixtures/internal'),resolve(dir,'fixtures/internal'),{recursive:true});
  mkdirSync(resolve(dir,'apps/legacy/public'),{recursive:true});for(const file of ['index.html','kalkulator.html','kontakt.html','podminky.html'])writeFileSync(resolve(dir,'apps/legacy/public',file),`<h1>Explicit TEST FIXTURE ${file}</h1>`);
  const systems=resolve(dir,'fixtures/internal/systems.json');const config=JSON.parse(readFileSync(systems,'utf8'));config.facts.provider='local_demo';config.facts.network='local';writeFileSync(systems,JSON.stringify(config));
  const registry=new SourceRegistry(dir),rules=new RulebookManager(store.db,registry),policy=new AgentPolicy(store,rules,{now});
  const cite=(id:string):Citation=>{const s=registry.get(id);return {source_id:s.source_id,version:s.version,hash:s.hash,excerpt:s.content};};
  // This proposal is authored by the test, never a production canned audit or seeded active rulebook.
  const activate=()=>{
    const params=registry.config(),evidence=Object.fromEntries(Object.keys(params).map(k=>[k,[cite(k==='supplier_allowed_actions'?'internal-partners':['auto_discount_bps','owner_approval_limit_bps','hard_discount_limit_bps','offer_ttl_seconds','deposit_minor'].includes(k)?'internal-operations':'internal-systems')]])) as RulebookProposal['evidence'];
    const p:RulebookProposal={params,evidence,profile:{name:'Pneu 007 TEST FIXTURE',summary:'Synthetic test-authored proposal for policy regression.',systems:['legacy-orders'],partners:['Pneu Partner Demo'],channels:['web'],citations:[cite('internal-systems')]},findings:[]};
    const v=rules.propose(business,p);return rules.activate(owner,v.version);
  };
  return {store,dir,registry,rules,policy,activate,advance:(ms:number)=>{time=new Date(time.getTime()+ms);},cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
function mandate(caseId:string,overrides:Partial<MandateInput>={}):MandateInput {
  return {case_id:caseId,mode:'book',service_spec:service,max_total_minor:250000,max_deposit_minor:50000,payment_mode:'deposit',latest_service_end:'2026-10-17T22:00:00Z',expires_at:'2026-10-08T10:00:00Z',allow_extras:false,currency:'CZK',network:'local',asset:'lovelace',max_asset_quantity:'25000000',max_network_fee:'2000000',mapping_version:'demo-czk-ada-v1',seller_id:'pneu007-seller',...overrides};
}
const mapping:CheckoutMapping={provider:'local_demo',network:'local',seller_id:'pneu007-seller',asset:'lovelace',asset_quantity:'5000000',max_network_fee:'2000000',mapping_version:'demo-czk-ada-v1'};
function accepted(t:ReturnType<typeof setup>, options:{discount?:number;mode?:'book'|'recommend';payment_mode?:'deposit'|'full';mandate?:Partial<MandateInput>}={}) {
  const c=t.policy.createCase(customer,{service_spec:service}),m=t.policy.proposeMandate(customer,mandate(c.id,{mode:options.mode??'book',payment_mode:options.payment_mode??'deposit',...options.mandate}));
  t.policy.approveMandate(human,m.id);const q=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:options.discount??0});
  if(q.approval)t.policy.decideApproval(owner,q.approval.id,'approved');
  return {c,m,q,result:t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:m.id})};
}
test('only customer human may approve their mandate; identities and cases are scoped',()=>{
  const t=setup();try {
    const c=t.policy.createCase(customer,{service_spec:service,relay_task_id:'real-task-test-fixture'}),m=t.policy.proposeMandate(customer,mandate(c.id));
    assert.equal(c.customer_id,'customer-001');assert.equal(m.status,'pending');
    for(const actor of [customer,business,owner,humanB])assert.throws(()=>t.policy.approveMandate(actor,m.id),{code:'FORBIDDEN'});
    for(const actor of [customerB,humanB,{id:'other-bot',role:'business_agent'} as Actor])assert.throws(()=>t.policy.getCase(actor,c.id),{code:'FORBIDDEN'});
    assert.throws(()=>t.policy.getMandate(customerB,m.id),{code:'FORBIDDEN'});
    assert.equal(t.policy.listCases(customerB).length,0);assert.equal(t.policy.listCases(owner).length,1);
    assert.equal(t.policy.approveMandate(human,m.id).approved_by,human.id);
    assert.throws(()=>t.policy.createCase(customer,{service_spec:service,customer_id:'customer-002'} as never),{code:'INVALID_INPUT'});
  }finally{t.cleanup();}
});
test('recommend mandate returns recommendation and never creates order, hold or payment',()=>{
  const t=setup();try {
    t.activate();const before=t.store.listOrders().length,{result}=accepted(t,{mode:'recommend'});
    assert.equal(result.status,'recommended');assert.equal(result.order,undefined);assert.equal(t.store.listOrders().length,before);
    assert.equal(t.store.listPaymentIntents().length,0);assert.equal((t.store.db.prepare('SELECT COUNT(*) n FROM booking_holds').get() as {n:number}).n,0);
  }finally{t.cleanup();}
});
test('inactive rulebook blocks bot quotes; active automatic and owner discounts bind real quote version',()=>{
  const t=setup();try {
    const c=t.policy.createCase(customer,{service_spec:service});assert.throws(()=>t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:0}),{code:'RULEBOOK_INACTIVE'});
    t.activate();const q=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:500});assert.equal(q.approval,undefined);
    const request=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:1000});assert.equal(request.approval!.status,'pending');
    const m=t.policy.proposeMandate(customer,mandate(c.id));t.policy.approveMandate(human,m.id);
    assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:request.quote.id,mandate_id:m.id}),{code:'OWNER_APPROVAL_REQUIRED'});
    assert.throws(()=>t.policy.decideApproval(business,request.approval!.id,'approved'),{code:'FORBIDDEN'});
    const approved=t.policy.decideApproval(owner,request.approval!.id,'approved');assert.equal(approved.decided_by,'staff-owner');
    const acceptance=t.policy.accept(customer,c.id,{quote_id:request.quote.id,mandate_id:m.id});assert.equal(acceptance.status,'accepted');
    const auth=t.policy.authorizationForCheckout(business,acceptance.order!.id,mapping);assert.equal(auth.actor_id,customer.id);assert.equal(auth.rulebook_version,request.quote.rulebook_version);assert.equal(auth.quote_id,request.quote.id);
    assert.throws(()=>t.policy.quote(business,t.policy.createCase(customer,{service_spec:service}).id,{slot_id:'slot-main',discount_bps:1001}),{code:'DISCOUNT_FORBIDDEN'});
  }finally{t.cleanup();}
});
test('limits, pending mandate, expiry, service deadline, mapping, fee and payment mode fail closed',()=>{
  const t=setup();try {
    t.activate();const c=t.policy.createCase(customer,{service_spec:service}),q=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:0});
    const tooLow=t.policy.proposeMandate(customer,mandate(c.id,{max_total_minor:1000}));t.policy.approveMandate(human,tooLow.id);
    assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:tooLow.id}),{code:'MANDATE_LIMIT'});
    const pending=t.policy.proposeMandate(customer,mandate(c.id));assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:pending.id}),{code:'MANDATE_APPROVAL_REQUIRED'});
    const deadline=t.policy.proposeMandate(customer,mandate(c.id,{latest_service_end:'2026-10-16T14:30:00Z'}));t.policy.approveMandate(human,deadline.id);assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:deadline.id}),{code:'MANDATE_SERVICE_DEADLINE'});
    t.policy.approveMandate(human,pending.id);const r=t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:pending.id});
    assert.throws(()=>t.policy.authorizationForCheckout(business,r.order!.id,{...mapping,seller_id:'other-seller'}),{code:'MANDATE_PAYMENT_LIMIT'});
    assert.throws(()=>t.policy.authorizationForCheckout(business,r.order!.id,{...mapping,max_network_fee:'2000001'}),{code:'MANDATE_PAYMENT_LIMIT'});
    assert.throws(()=>t.policy.authorizationForCheckout(business,r.order!.id,{...mapping,asset_quantity:'24720000'}),{code:'PAYMENT_MAPPING_MISMATCH'});
    assert.throws(()=>t.policy.authorizationForCheckout(customer,r.order!.id,mapping),{code:'FORBIDDEN'});
    t.advance(600001);assert.throws(()=>t.policy.authorizationForCheckout(business,r.order!.id,mapping),{code:'QUOTE_EXPIRED'});
    const expired=t.policy.proposeMandate(customer,mandate(t.policy.createCase(customer,{service_spec:service}).id,{expires_at:'2026-10-08T08:10:02Z'}));t.advance(3000);assert.throws(()=>t.policy.approveMandate(human,expired.id),{code:'MANDATE_EXPIRED'});
  }finally{t.cleanup();}
});
test('reaudit 5→3 creates owner request for identical 4 percent and refuses old versions',()=>{
  const t=setup();try {
    t.activate();const c=t.policy.createCase(customer,{service_spec:service}),old=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:400});assert.equal(old.approval,undefined);
    const m=t.policy.proposeMandate(customer,mandate(c.id));t.policy.approveMandate(human,m.id);
    const path=resolve(t.dir,'fixtures/internal/operations.md');writeFileSync(path,readFileSync(path,'utf8').replace('auto_discount_bps=500','auto_discount_bps=300'));
    assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:old.quote.id,mandate_id:m.id}),(error:unknown)=>['STALE_SOURCE','UNSUPPORTED_POLICY'].includes((error as {code:string}).code));
    t.activate();assert.throws(()=>t.policy.accept(customer,c.id,{quote_id:old.quote.id,mandate_id:m.id}),{code:'QUOTE_BINDING_MISMATCH'});
    const next=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:400});assert.equal(next.approval!.status,'pending');
    t.policy.decideApproval(owner,next.approval!.id,'approved');assert.equal(t.policy.accept(customer,c.id,{quote_id:next.quote.id,mandate_id:m.id}).status,'accepted');
  }finally{t.cleanup();}
});
test('owner approval is quote-bound and rejection is immutable; changed price/version cannot be replayed',()=>{
  const t=setup();try {
    t.activate();const c=t.policy.createCase(customer,{service_spec:service}),q=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:700});
    const rejected=t.policy.decideApproval(owner,q.approval!.id,'rejected');assert.equal(rejected.status,'rejected');
    assert.throws(()=>t.policy.decideApproval(owner,q.approval!.id,'approved'),{code:'APPROVAL_ALREADY_DECIDED'});
    const fresh=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:700});t.store.db.prepare('UPDATE quotes SET version=version+1 WHERE id=?').run(fresh.quote.id);
    assert.throws(()=>t.policy.decideApproval(owner,fresh.approval!.id,'approved'),{code:'QUOTE_BINDING_MISMATCH'});
  }finally{t.cleanup();}
});
test('accepted authorization survives policy object recreation and cannot exceed stored full-payment mandate',()=>{
  const t=setup();try {
    t.activate();const {result}=accepted(t,{payment_mode:'full'});
    const recreated=new AgentPolicy(t.store,t.rules,{now:t.policy.now});
    const auth=recreated.authorizationForCheckout(business,result.order!.id,{...mapping,asset_quantity:'24720000'});
    assert.equal(auth.payment_mode,'full');assert.equal(auth.actor_id,customer.id);
    assert.throws(()=>recreated.authorizationForCheckout(business,result.order!.id,{...mapping,asset_quantity:'25000001'}),{code:'MANDATE_PAYMENT_LIMIT'});
    const intent=t.store.prepareCheckout(result.order!.id,{authorization:auth,provider:'local_demo',sku:'full-quote',asset_quantity:auth.asset_quantity,max_network_fee:auth.max_network_fee,seller_id:auth.seller_id});
    assert.equal(intent.payment_mode,'full');assert.equal(intent.amount_minor,247200);
  }finally{t.cleanup();}
});
test('expired approved mandate and altered accepted quote cannot authorize spending',()=>{
  const t=setup();try {
    t.activate();const {result}=accepted(t,{mandate:{expires_at:'2026-10-08T08:00:10Z'}});
    t.advance(11000);assert.throws(()=>t.policy.authorizationForCheckout(business,result.order!.id,mapping),{code:'MANDATE_EXPIRED'});
    const other=accepted(t);t.store.db.prepare('UPDATE quotes SET version=version+1 WHERE id=?').run(other.result.quote.id);
    assert.throws(()=>t.policy.authorizationForCheckout(business,other.result.order!.id,mapping),{code:'QUOTE_BINDING_MISMATCH'});
  }finally{t.cleanup();}
});
test('mandate accepts RFC3339 offsets and compares normalized UTC service deadline and expiration',()=>{
  const t=setup();try {
    t.activate();const c=t.policy.createCase(customer,{service_spec:service});
    const m=t.policy.proposeMandate(customer,mandate(c.id,{latest_service_end:'2026-10-16T18:00:00+02:00',expires_at:'2026-10-08T12:00:00+02:00'}));
    assert.equal(m.latest_service_end,'2026-10-16T16:00:00.000Z');assert.equal(m.expires_at,'2026-10-08T10:00:00.000Z');
    t.policy.approveMandate(human,m.id);const q=t.policy.quote(business,c.id,{slot_id:'slot-main',discount_bps:0});
    assert.equal(t.policy.accept(customer,c.id,{quote_id:q.quote.id,mandate_id:m.id}).status,'accepted');
    const tight=t.policy.createCase(customer,{service_spec:service});const late=t.policy.proposeMandate(customer,mandate(tight.id,{latest_service_end:'2026-10-16T16:30:00+02:00'}));
    t.policy.approveMandate(human,late.id);const q2=t.policy.quote(business,tight.id,{slot_id:'slot-main',discount_bps:0});
    assert.throws(()=>t.policy.accept(customer,tight.id,{quote_id:q2.quote.id,mandate_id:late.id}),{code:'MANDATE_SERVICE_DEADLINE'});
    assert.throws(()=>t.policy.proposeMandate(customer,mandate(tight.id,{latest_service_end:'2026-10-16T18:00:00+99:00'})),{code:'INVALID_INPUT'});
  }finally{t.cleanup();}
});
