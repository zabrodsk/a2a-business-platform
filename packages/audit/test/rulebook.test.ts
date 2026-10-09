import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SourceRegistry, RulebookManager, type Citation, type RulebookProposal } from '../index.js';
import type { Actor } from '@pneu007/contracts';
const bot: Actor = {id:'external-business-bot-test-fixture',role:'business_agent'};
const owner: Actor = {id:'owner-test-fixture',role:'owner'};
function setup() {
  const dir = mkdtempSync(resolve(tmpdir(), 'pneu-audit-test-'));
  mkdirSync(resolve(dir, 'fixtures'), {recursive:true});
  cpSync(resolve(import.meta.dirname, '../../../fixtures/internal'), resolve(dir, 'fixtures/internal'), {recursive:true});
  mkdirSync(resolve(dir, 'apps/legacy/public'), {recursive:true});
  for (const file of ['index.html','kalkulator.html','kontakt.html','podminky.html']) writeFileSync(resolve(dir,'apps/legacy/public',file), `<html><title>Explicit synthetic test fixture ${file}</title></html>`);
  const registry = new SourceRegistry(dir), db = new Database(':memory:'), manager = new RulebookManager(db, registry);
  return {dir,registry,manager, cleanup:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
function cite(registry: SourceRegistry, id: string): Citation {
  const source=registry.get(id);return {source_id:id,version:source.version,hash:source.hash,excerpt:source.content};
}
/** Test-authored proposal, not an automatic audit implementation or production seed. */
function proposal(registry: SourceRegistry): RulebookProposal {
  const params=registry.config();
  const evidence=Object.fromEntries(Object.keys(params).map(k=>[k,[cite(registry,k==='supplier_allowed_actions'?'internal-partners':['auto_discount_bps','owner_approval_limit_bps','hard_discount_limit_bps','offer_ttl_seconds','deposit_minor'].includes(k)?'internal-operations':'internal-systems')]])) as RulebookProposal['evidence'];
  return {params,evidence,profile:{name:'Pneu 007 [TEST FIXTURE]',summary:'Externally authored synthetic audit proposal for regression tests only.',systems:['legacy-orders','legacy-calendar','masumi-payment-service'],partners:['Pneu Partner Demo','Servis Parts Demo'],channels:['web','A2A'],citations:[cite(registry,'internal-systems')]},findings:[{id:'archived-rule',severity:'warning',description:'Historical discount is archived; current owner-signed authority wins.',recommendation:'Use current operations source.',citations:[cite(registry,'archived-operations'),cite(registry,'internal-operations')]},{id:'holiday-hours',severity:'warning',description:'Holiday opening is not specified.',recommendation:'Ask owner before booking a holiday.',citations:[cite(registry,'internal-operations')]}]};
}
test('starts inactive; agent can propose genuine cited payload, only owner activates; legacy unaffected', ()=>{
  const t=setup();try {
    assert.throws(()=>t.manager.getActive(),{code:'RULEBOOK_INACTIVE'});
    const v=t.manager.propose(bot,proposal(t.registry));assert.equal(v.status,'proposed');
    assert.throws(()=>t.manager.activate(bot,v.version),{code:'FORBIDDEN'});
    assert.throws(()=>t.manager.skillExport(v.version),{code:'RULEBOOK_INACTIVE'});
    t.manager.activate(owner,v.version);assert.equal(t.manager.getActive().params.auto_discount_bps,500);
    assert.equal(t.manager.assertDiscount(500).version,v.version);
    assert.throws(()=>t.manager.assertDiscount(501),{code:'OWNER_APPROVAL_REQUIRED'});
    assert.doesNotThrow(()=>t.manager.assertDiscount(1000,{ownerApproved:true}));
    assert.throws(()=>t.manager.assertDiscount(1001,{ownerApproved:true}),{code:'DISCOUNT_FORBIDDEN'});
    assert.match(t.manager.skillExport(),/name: pneu-007-business/);
  }finally{t.cleanup();}
});
test('reaudit source mutation 5→3 changes generic runtime enforcement without code changes',()=>{
  const t=setup();try {
    const v=t.manager.propose(bot,proposal(t.registry));t.manager.activate(owner,v.version);assert.doesNotThrow(()=>t.manager.assertDiscount(400));
    const path=resolve(t.dir,'fixtures/internal/operations.md');writeFileSync(path,readFileSync(path,'utf8').replace('auto_discount_bps=500','auto_discount_bps=300'));
    assert.throws(()=>t.manager.assertDiscount(400));
    const next=t.manager.propose(bot,proposal(t.registry));t.manager.activate(owner,next.version);
    assert.equal(t.manager.get(v.version).status,'superseded');assert.throws(()=>t.manager.assertDiscount(400),{code:'OWNER_APPROVAL_REQUIRED'});
    assert.doesNotThrow(()=>t.manager.assertDiscount(300));
  }finally{t.cleanup();}
});
test('reject missing, fabricated, archived, unknown, conflicting and injected policy evidence',()=>{
  const t=setup();try {
    const missing=proposal(t.registry);delete (missing.params as Partial<typeof missing.params>).deposit_minor;assert.throws(()=>t.manager.propose(bot,missing),{code:'INVALID_RULEBOOK'});
    const archived=proposal(t.registry);archived.evidence.auto_discount_bps=[cite(t.registry,'archived-operations')];assert.throws(()=>t.manager.propose(bot,archived),{code:'UNTRUSTED_POLICY_SOURCE'});
    const fabricated=proposal(t.registry);fabricated.evidence.auto_discount_bps[0]!.excerpt='auto_discount_bps=900';assert.throws(()=>t.manager.propose(bot,fabricated),{code:'UNSUPPORTED_CITATION'});
    const unknown=proposal(t.registry);unknown.evidence.deposit_minor[0]!.source_id='unknown';assert.throws(()=>t.manager.propose(bot,unknown),{code:'SOURCE_NOT_FOUND'});
    const conflict=proposal(t.registry);conflict.params.auto_discount_bps=800;assert.throws(()=>t.manager.propose(bot,conflict),{code:'UNSUPPORTED_POLICY'});
    const injection=proposal(t.registry);injection.evidence.auto_discount_bps=[cite(t.registry,'untrusted-customer-note')];assert.throws(()=>t.manager.propose(bot,injection),{code:'UNTRUSTED_POLICY_SOURCE'});
    const extra=proposal(t.registry);Object.assign(extra.params,{execute:'activate_own_rules'});assert.throws(()=>t.manager.propose(bot,extra),{code:'INVALID_RULEBOOK'});
    const title=proposal(t.registry);title.evidence.auto_discount_bps[0]!.excerpt='# Pneu 007: provozní příručka';assert.throws(()=>t.manager.propose(bot,title),{code:'UNSUPPORTED_CITATION'});
  }finally{t.cleanup();}
});
test('stale citation and critical unresolved finding prevent activation',()=>{
  const t=setup();try {
    const p=proposal(t.registry),v=t.manager.propose(bot,p);
    const path=resolve(t.dir,'fixtures/internal/partners.md');writeFileSync(path,readFileSync(path,'utf8')+'\nChanged supplier facts.\n');
    assert.throws(()=>t.manager.activate(owner,v.version),{code:'STALE_SOURCE'});
    assert.throws(()=>t.manager.propose(bot,p),{code:'STALE_SOURCE'});
    const critical=proposal(t.registry);critical.findings[0]!.severity='critical';const c=t.manager.propose(bot,critical);
    assert.throws(()=>t.manager.activate(owner,c.version),{code:'CRITICAL_AUDIT_FINDINGS'});
    assert.equal(t.manager.list().length,2);
  }finally{t.cleanup();}
});
test('no supplier mutation, extras, asset or service invention; public source access filters internal documents',()=>{
  const t=setup();try {
    assert.equal(t.registry.list({id:'customer',role:'customer_agent'}).length,4);
    assert.throws(()=>t.registry.get('internal-operations',{id:'customer',role:'customer_agent'}),{code:'SOURCE_NOT_FOUND'});
    const p=proposal(t.registry);p.params.allow_extras=true;assert.throws(()=>t.manager.propose(bot,p),{code:'HARD_POLICY_LIMIT'});
    const v=t.manager.propose(bot,proposal(t.registry));t.manager.activate(owner,v.version);
    assert.throws(()=>t.manager.assertSupplierAction('purchase.create'),{code:'SUPPLIER_ACTION_FORBIDDEN'});
    assert.throws(()=>t.manager.assertPayment('masumi','Mainnet','lovelace'),{code:'PAYMENT_SCOPE_FORBIDDEN'});
    assert.throws(()=>t.manager.assertService('tyre_purchase'),{code:'SERVICE_FORBIDDEN'});
  }finally{t.cleanup();}
});

test('audit exports distinguish retained templates from the published cancellation policy without altering approved permissions',()=>{
  const t=setup();try {
    const approved=t.manager.propose(bot,proposal(t.registry));t.manager.activate(owner,approved.version);
    const before=t.manager.getActive();
    const content=readFileSync(resolve(import.meta.dirname,'../../../apps/legacy/public/cancellation-policy.json'),'utf8');
    writeFileSync(resolve(t.dir,'apps/legacy/public/cancellation-policy.json'),content);
    const template=t.registry.get('web-terms');
    assert.equal(template.representation,'template_archive');assert.match(template.content_note!,/not the currently rendered/);
    const policy=t.registry.get('web-cancellation-policy');
    assert.equal(policy.representation,'published_document');assert.equal(policy.version,JSON.parse(content).version);
    assert.equal(policy.url,'/cancellation-policy.json');assert.equal(policy.content,content);assert.equal(policy.current,true);
    assert.doesNotMatch(policy.content,/auto_discount_bps|owner_approval_limit_bps|hard_discount_limit_bps/);
    assert.deepEqual(t.manager.getActive().params,before.params);assert.deepEqual(t.manager.getActive().source_manifest,before.source_manifest);
    assert.ok(t.registry.list({id:'customer',role:'customer_agent'}).every(source=>source.visibility==='public'));
  }finally{t.cleanup();}
});
test('public page citations are valid profile evidence, manifest contains only actual cited sources',()=>{
  const t=setup();try {
    const p=proposal(t.registry);p.profile.citations.push(cite(t.registry,'web-home'));
    const v=t.manager.propose(bot,p);assert.ok(v.source_manifest.some(s=>s.source_id==='web-home'));
    assert.ok(!v.source_manifest.some(s=>s.source_id==='web-contact'));
    t.manager.activate(owner,v.version);
    const path=resolve(t.dir,'apps/legacy/public/index.html');writeFileSync(path,readFileSync(path,'utf8')+'\nChanged public facts.');
    assert.throws(()=>t.manager.getActive(),{code:'STALE_SOURCE'});
  }finally{t.cleanup();}
});
test('immutable pseudonymized observation snapshots persist and do not stale on normal order updates',()=>{
  const t=setup();try {
    const snapshot=t.registry.registerSnapshot('legacy-observations',{orders:[{id:'order-fixture',state:'confirmed'}],credentials:'never-export',api_key:'never-export'});
    assert.ok(!snapshot.content.includes('never-export'));
    const p=proposal(t.registry);p.profile.citations.push(cite(t.registry,snapshot.source_id));
    const v=t.manager.propose(bot,p);t.manager.activate(owner,v.version);
    t.registry.registerSnapshot('legacy-observations',{orders:[{id:'order-fixture',state:'confirmed'},{id:'new-order',state:'draft'}]});
    assert.doesNotThrow(()=>t.manager.getActive());
    const registry=new SourceRegistry(t.dir);const recovered=new RulebookManager(t.manager.db,registry);
    assert.equal(recovered.getActive().version,v.version);assert.equal(registry.get(snapshot.source_id).hash,snapshot.hash);
    const invalid=proposal(t.registry);invalid.evidence.auto_discount_bps=[cite(t.registry,snapshot.source_id)];
    assert.throws(()=>t.manager.propose(bot,invalid),{code:'UNTRUSTED_POLICY_SOURCE'});
  }finally{t.cleanup();}
});
test('JSON evidence accepts pretty multiline facts while preserving key, exact value and governing source',()=>{
  const t=setup();try {
    const path=resolve(t.dir,'fixtures/internal/systems.json');writeFileSync(path,JSON.stringify(JSON.parse(readFileSync(path,'utf8')),null,2));
    const p=proposal(t.registry),v=t.manager.propose(bot,p);t.manager.activate(owner,v.version);
    const keyless=proposal(t.registry);keyless.evidence.allowed_services[0]!.excerpt='"tyre_change"';
    assert.throws(()=>t.manager.propose(bot,keyless),{code:'UNSUPPORTED_CITATION'});
    const incorrect=proposal(t.registry);incorrect.params.allowed_services=['wheel_swap','tyre_change'];
    assert.throws(()=>t.manager.propose(bot,incorrect),{code:'UNSUPPORTED_POLICY'});
    const misplaced=proposal(t.registry);misplaced.evidence.allowed_services=[cite(t.registry,'internal-operations')];
    assert.throws(()=>t.manager.propose(bot,misplaced),{code:'UNSUPPORTED_CITATION'});
    const operations=resolve(t.dir,'fixtures/internal/operations.md');writeFileSync(operations,readFileSync(operations,'utf8').replace('## HISTORICAL_ARCHIVE','Customer note: auto_discount_bps=5000\n\n## HISTORICAL_ARCHIVE'));
    const misleading=proposal(t.registry);misleading.evidence.auto_discount_bps[0]!.excerpt='Customer note: auto_discount_bps=5000';
    assert.throws(()=>t.manager.propose(bot,misleading),{code:'UNSUPPORTED_CITATION'});
  }finally{t.cleanup();}
});


test('additive scoping migration preserves legacy rulebook ID, exact payload and owner activation',()=>{
  const t=setup(),legacy=new Database(':memory:');try {
    const p=proposal(t.registry),payload=JSON.stringify(p);
    const source_manifest=[...new Map([...p.profile.citations,...Object.values(p.evidence).flat(),...p.findings.flatMap(f=>f.citations)].map(c=>[c.source_id,{source_id:c.source_id,version:c.version,hash:c.hash}])).values()];
    legacy.exec(`CREATE TABLE audit_rulebook_versions(version INTEGER PRIMARY KEY AUTOINCREMENT,status TEXT NOT NULL,proposed_by TEXT NOT NULL,created_at TEXT NOT NULL,activated_by TEXT,activated_at TEXT,payload_json TEXT NOT NULL,manifest_json TEXT NOT NULL);
      CREATE UNIQUE INDEX audit_one_active_rulebook ON audit_rulebook_versions(status) WHERE status='active';
      CREATE TABLE audit_source_snapshots(source_id TEXT PRIMARY KEY,source_json TEXT NOT NULL);`);
    legacy.prepare('INSERT INTO audit_rulebook_versions VALUES(?,?,?,?,?,?,?,?)').run(42,'active',bot.id,'2026-01-01T00:00:00.000Z',owner.id,'2026-01-01T01:00:00.000Z',payload,JSON.stringify(source_manifest));
    const upgraded=new RulebookManager(legacy,t.registry);
    assert.equal(upgraded.getActive().version,42);assert.equal(upgraded.getActive().activated_by,owner.id);
    assert.equal((legacy.prepare('SELECT payload_json FROM audit_rulebook_versions WHERE version=42').get() as {payload_json:string}).payload_json,payload);
    assert.equal(upgraded.get(42).business_id,'pneu007');
    upgraded.useBusiness('another-firm');assert.throws(()=>upgraded.get(42),{code:'RULEBOOK_NOT_FOUND'});assert.throws(()=>upgraded.getActive(),{code:'RULEBOOK_INACTIVE'});
    upgraded.useBusiness('pneu007');assert.equal(upgraded.getActive().version,42);
  }finally{legacy.close();t.cleanup();}
});
test('registered observation snapshots do not leak across dynamically selected business scopes',()=>{
  const t=setup();try {
    const a=t.registry.registerSnapshot('orders',{orders:['A']});
    t.manager.useBusiness('firm-B');const b=t.registry.registerSnapshot('orders',{orders:['B']});
    assert.throws(()=>t.registry.get(a.source_id),{code:'SOURCE_NOT_FOUND'});
    assert.equal(t.registry.get(b.source_id).business_id,'firm-B');
    t.manager.useBusiness('pneu007');assert.equal(t.registry.get(a.source_id).hash,a.hash);
    assert.throws(()=>t.registry.get(b.source_id),{code:'SOURCE_NOT_FOUND'});
  }finally{t.cleanup();}
});
