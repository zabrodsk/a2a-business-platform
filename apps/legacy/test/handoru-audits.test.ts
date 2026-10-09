import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Actor } from '../../../packages/contracts/index.js';
import { RulebookManager, rulebookFields, type Citation, type RulebookProposal, type Source } from '../../../packages/audit/index.js';
import { HandoruAudits, type AuditReportInput, type RulebookSubmission } from '../src/handoru/audits.js';

const bot:Actor={id:'business-agent-A',role:'business_agent'};
const owner:Actor={id:'independent-handoru-human',role:'owner'};
function setup(businessId='firm-A',db=new Database(':memory:')) {
  let at=Date.now(); const now=()=>new Date(at);
  const audits=new HandoruAudits(db,businessId,{now,authorize(actor,action){
    if (actor.id!==bot.id&&actor.id!==owner.id) throw Object.assign(new Error('Membership or independent human session required'),{code:'FORBIDDEN'});
    if (action==='approve'&&actor.id!==owner.id) throw Object.assign(new Error('Human decision required'),{code:'FORBIDDEN'});
  }});
  const evidence=audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/admin/policies',locator:'Policies → Operations',captured_at:now().toISOString(),method:'browser',content_type:'text/plain',content:'Reviewed operations policy: autonomous discounts 3 percent, owner exceptions up to 10 percent. Deposit 500 CZK; offer lasts 20 minutes. Only four-wheel tyre change and wheel swap. No extras or supplier purchases. Local sandbox payment in lovelace.',redacted:true});
  const other=audits.archiveEvidence(bot,{system_id:'supplier-api',url:'https://supplier.example.test/api/catalog',locator:'GET /api/catalog; response.items',captured_at:now().toISOString(),method:'api',content_type:'application/json',content:'{"availability":"read only","supplier":"Fictional Tyre Supply"}',redacted:true});
  return {db,audits,evidence,other,now,advance:(ms:number)=>{at+=ms;}};
}
function cite(source:Source):Citation { return {source_id:source.source_id,version:source.version,hash:source.hash,excerpt:source.content}; }
function report(t:ReturnType<typeof setup>):AuditReportInput {
  return {schema_version:'1.0',title:'Agent-authored fixture audit of independent systems',summary:'Synthetic test report; no production audit is prefilled.',systems:[
    {id:'workshop-ui',name:'Legacy Workshop',url:'https://workshop.example.test/admin',purpose:'Orders and policy',access_methods:['browser'],observed_roles:['administrator'],fact_authority:['Native booking records; owner reviews policy']},
    {id:'supplier-api',name:'Independent Supplier',url:'https://supplier.example.test/',purpose:'Partner catalogue',access_methods:['api'],observed_roles:['reader'],fact_authority:['Supplier catalogue']}],
    processes:[{id:'booking',description:'Existing UI records bookings.',citations:[cite(t.evidence)]}],findings:[],questions:[],
    supported_writes:[{action:'supplier.catalog',system_id:'supplier-api',mode:'audit_only',description:'Catalogue read only; no purchasing permission inferred.',citations:[cite(t.other)]}]};
}
function submission(t:ReturnType<typeof setup>,reportVersion:number):RulebookSubmission {
  const params:RulebookProposal['params']={auto_discount_bps:300,owner_approval_limit_bps:1000,hard_discount_limit_bps:1000,offer_ttl_seconds:1200,deposit_minor:50000,allowed_services:['tyre_change','wheel_swap'],currency:'CZK',allow_extras:false,provider:'local_demo',network:'local',asset:'lovelace',supplier_allowed_actions:['catalog.read']};
  return {report_version:reportVersion,source_authority:{[t.evidence.source_id]:'policy_decision'},proposal:{profile:{name:'Independent test workshop',summary:'Human reviews this natural-language evidence and typed interpretation.',systems:['Legacy Workshop','Independent Supplier'],partners:['Fictional Tyre Supply'],channels:['web','A2A'],citations:[cite(t.evidence),cite(t.other)]},params,evidence:Object.fromEntries(rulebookFields.map(key=>[key,[cite(t.evidence)]])) as RulebookProposal['evidence'],findings:[]}};
}
function activate(t:ReturnType<typeof setup>,input:RulebookSubmission) {
  const proposed=t.audits.proposeRulebook(bot,input); return t.audits.activateRulebook(owner,{version:proposed.version,payload_hash:proposed.payload_hash});
}

test('generic browser/API evidence needs no fixture IDs or config equality; exact human activation persists',()=>{
  const t=setup(); try {
    assert.throws(()=>t.audits.rulebooks.getActive(),{code:'RULEBOOK_INACTIVE'});
    const archived=t.audits.createReport(bot,report(t)); assert.equal(archived.systems.length,2);
    assert.equal(t.audits.getFreshness(bot,t.evidence.source_id).status,'unknown');
    const p=t.audits.proposeRulebook(bot,submission(t,archived.version));
    assert.throws(()=>t.audits.activateRulebook(bot,{version:p.version,payload_hash:p.payload_hash}),{code:'FORBIDDEN'});
    assert.throws(()=>t.audits.activateRulebook(owner,{version:p.version,payload_hash:'0'.repeat(64)}),{code:'RULEBOOK_HASH_MISMATCH'});
    assert.equal(t.audits.activateRulebook(owner,{version:p.version,payload_hash:p.payload_hash}).params.auto_discount_bps,300);
    assert.throws(()=>t.audits.rulebooks.assertDiscount(400),{code:'OWNER_APPROVAL_REQUIRED'});
    assert.doesNotThrow(()=>t.audits.rulebooks.assertDiscount(300));
    const recovered=new HandoruAudits(t.db,'firm-A',t.audits.options);
    assert.equal(recovered.rulebooks.getActive().version,p.version);
    t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/admin/orders',locator:'Recent orders',captured_at:t.now().toISOString(),method:'browser',content_type:'text/plain',content:'A new ordinary order exists.',redacted:true});
    assert.equal(t.audits.rulebooks.getActive().version,p.version,'Ordinary observed order changes do not stale policy');
  }finally{t.db.close();}
});
test('business scope prevents evidence/proposal/context reads and permits one active rulebook per firm',()=>{
  const a=setup(),b=setup('firm-B',a.db); try {
    const ra=a.audits.createReport(bot,report(a)),rb=b.audits.createReport(bot,report(b));
    assert.throws(()=>b.audits.getEvidence(bot,a.evidence.source_id),{code:'SOURCE_NOT_FOUND'});
    assert.throws(()=>b.audits.getReport(bot,ra.version),{code:'AUDIT_RECORD_NOT_FOUND'});
    const foreign=submission(b,rb.version);foreign.proposal.evidence.auto_discount_bps=[cite(a.evidence)];
    assert.throws(()=>b.audits.proposeRulebook(bot,foreign),{code:'SOURCE_NOT_FOUND'});
    const va=activate(a,submission(a,ra.version)),vb=activate(b,submission(b,rb.version));
    assert.equal(a.audits.rulebooks.getActive().version,va.version); assert.equal(b.audits.rulebooks.getActive().version,vb.version);
    assert.throws(()=>a.audits.rulebooks.get(vb.version),{code:'RULEBOOK_NOT_FOUND'});
    const context=a.audits.context(bot); assert.ok(context.cursor>=va.version); assert.ok(context.evidence.every(source=>source.business_id==='firm-A'));
  }finally{a.db.close();}
});
test('critical unknown blocks only its action; owner answer is immutable and must be cited by new proposal',()=>{
  const t=setup(); try {
    const input=report(t); input.questions=[{id:'deposit-policy',question:'What deposit is authorized?',critical:true,affected_parameters:['deposit_minor'],citations:[]}];
    const r=t.audits.createReport(bot,input),first=activate(t,submission(t,r.version));
    assert.doesNotThrow(()=>t.audits.rulebooks.assertDiscount(100));
    assert.doesNotThrow(()=>t.audits.rulebooks.assertSupplierAction('catalog.read'));
    assert.throws(()=>t.audits.rulebooks.assertPayment('local_demo','local','lovelace'),{code:'UNRESOLVED_POLICY'});
    const answer=t.audits.answerQuestion(owner,{report_version:r.version,question_id:'deposit-policy',answer:'The authorized deposit is 500 CZK.',kind:'policy_decision',scope:'Pneu deposit policy',valid_until:new Date(t.now().getTime()+60000).toISOString()});
    assert.equal(answer.evidence.capture?.method,'owner');
    assert.equal(t.audits.rulebooks.get(first.version).governance!.blocked_parameters.includes('deposit_minor'),true);
    const next=submission(t,r.version);next.proposal.evidence.deposit_minor=[cite(answer.evidence)];next.source_authority[answer.evidence.source_id]='policy_decision';
    activate(t,next); assert.doesNotThrow(()=>t.audits.rulebooks.assertPayment('local_demo','local','lovelace'));
    t.advance(60001); assert.doesNotThrow(()=>t.audits.rulebooks.assertDiscount(100));
    assert.throws(()=>t.audits.rulebooks.assertPayment('local_demo','local','lovelace'),{code:'UNRESOLVED_POLICY'});
  }finally{t.db.close();}
});
test('direct manager proposal cannot erase a report critical unknown; legacy admin role is not independent owner session',()=>{
  const t=setup(); try {
    const input=report(t);input.questions=[{id:'discount',question:'Unspecified discount authority?',critical:true,affected_parameters:['auto_discount_bps'],citations:[]}];
    const r=t.audits.createReport(bot,input),s=submission(t,r.version);
    s.proposal.governance={report_version:r.version,blocked_parameters:[],source_authority:s.source_authority,required_capabilities:[]};
    assert.throws(()=>t.audits.rulebooks.propose(bot,s.proposal),{code:'UNRESOLVED_POLICY'});
    const proposed=t.audits.proposeRulebook(bot,s);
    assert.throws(()=>t.audits.activateRulebook({id:'legacy-admin-shared-with-bot',role:'owner'},{version:proposed.version,payload_hash:proposed.payload_hash}),{code:'FORBIDDEN'});
    assert.throws(()=>t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/admin',locator:'Fake human approval',captured_at:t.now().toISOString(),method:'owner',content_type:'text/plain',content:'Approved by bot impersonating owner',redacted:true}),{code:'FORBIDDEN'});
  }finally{t.db.close();}
});
test('archive checksum does not prove live state; new read/revision required and changes block only affected parameters',()=>{
  const t=setup(); try {
    const r=t.audits.createReport(bot,report(t)),s=submission(t,r.version);s.source_authority[t.evidence.source_id]='external_fact';activate(t,s);
    assert.throws(()=>t.audits.rulebooks.assertDiscount(100),{code:'EVIDENCE_FRESHNESS_REQUIRED'});
    assert.throws(()=>t.audits.recordFreshness(bot,{source_id:t.evidence.source_id,status:'current',method:'browser'}),{code:'INVALID_AUDIT'});
    const check=t.audits.recordFreshness(bot,{source_id:t.evidence.source_id,status:'current',method:'browser',observed_content:t.evidence.content});
    assert.equal(check.verification,'agent_reported_reread');assert.doesNotThrow(()=>t.audits.rulebooks.assertDiscount(100));
    t.advance(300001);assert.throws(()=>t.audits.rulebooks.assertDiscount(100),{code:'EVIDENCE_FRESHNESS_REQUIRED'});
    assert.equal(t.audits.getFreshness(bot,t.evidence.source_id).status,'unknown');
    t.audits.recordFreshness(bot,{source_id:t.evidence.source_id,status:'changed',method:'browser',observed_content:'Changed operations policy'});
    assert.throws(()=>t.audits.rulebooks.assertDiscount(100),{code:'EVIDENCE_FRESHNESS_REQUIRED'});
  }finally{t.db.close();}
});
test('fabricated citations, unredacted secrets, unsupported hard limits and modified evidence fail closed',()=>{
  const t=setup(); try {
    const bad=report(t);bad.processes[0]!.citations[0]!.excerpt='Never observed fact';
    assert.throws(()=>t.audits.createReport(bot,bad),{code:'UNSUPPORTED_CITATION'});
    assert.throws(()=>t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/?api_key=unsafe',locator:'URL',captured_at:t.now().toISOString(),method:'browser',content_type:'text/plain',content:'Nothing',redacted:true}),{code:'INVALID_AUDIT'});
    assert.throws(()=>t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/',locator:'Credential',captured_at:t.now().toISOString(),method:'browser',content_type:'text/plain',content:'authorization: Bearer secretcredential',redacted:true}),{code:'UNREDACTED_EVIDENCE'});
    const r=t.audits.createReport(bot,report(t)),s=submission(t,r.version);s.proposal.params.hard_discount_limit_bps=1500;
    assert.throws(()=>t.audits.proposeRulebook(bot,s),{code:'HARD_POLICY_LIMIT'});
    const source={...t.evidence,content:'Tampered'};t.db.prepare('UPDATE audit_source_snapshots SET source_json=? WHERE source_id=?').run(JSON.stringify(source),source.source_id);
    assert.throws(()=>t.audits.getEvidence(bot,source.source_id),{code:'ARCHIVE_INTEGRITY_FAILED'});
  }finally{t.db.close();}
});
test('screenshots preserve actual bytes with caption reviewed by a human; hash is not OCR truth',()=>{
  const t=setup();try {
    const capture=t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/admin',locator:'Policy screen',captured_at:t.now().toISOString(),method:'browser',content_type:'image/png',content:'Agent interpretation: displayed policy requires human review.',attachment_base64:'iVBORw0KGgo=',redacted:true});
    assert.equal(capture.attachment_base64,'iVBORw0KGgo=');assert.equal(t.audits.getFreshness(bot,capture.source_id).status,'unknown');
    const modified={...capture,content:'Forged interpretation'};t.db.prepare('UPDATE audit_source_snapshots SET source_json=? WHERE source_id=?').run(JSON.stringify(modified),capture.source_id);
    assert.throws(()=>t.audits.getEvidence(bot,capture.source_id),{code:'ARCHIVE_INTEGRITY_FAILED'});
  }finally{t.db.close();}
});


test('compatibility native manager reads a new generic active version without reverting to fixture configuration',()=>{
  const t=setup('pneu007');try {
    const r=t.audits.createReport(bot,report(t)),v=activate(t,submission(t,r.version));
    const native=new RulebookManager(t.db,t.audits.registry);
    assert.equal(native.genericEvidence,false);
    assert.equal(native.getActive().version,v.version);
    assert.doesNotThrow(()=>native.assertDiscount(300));
    assert.match(native.skillExport(),/Independent test workshop/);
    assert.match(native.skillExport(),/Archived bytes do not prove external freshness/);
  }finally{t.db.close();}
});
test('native revision changes and human external-state answers cannot bypass currentness checks',()=>{
  const t=setup();try {
    const input=report(t);input.questions=[{id:'deposit',question:'External deposit setting?',critical:true,affected_parameters:['deposit_minor'],citations:[]}];
    const r=t.audits.createReport(bot,input),answer=t.audits.answerQuestion(owner,{report_version:r.version,question_id:'deposit',answer:'I observed the external deposit set to 500 CZK.',kind:'external_fact',scope:'Observed external setting only'});
    const s=submission(t,r.version);s.proposal.evidence.deposit_minor=[cite(answer.evidence)];s.source_authority[answer.evidence.source_id]='policy_decision';
    assert.throws(()=>t.audits.proposeRulebook(bot,s),{code:'UNTRUSTED_POLICY_SOURCE'});
    s.source_authority[answer.evidence.source_id]='external_fact';activate(t,s);
    assert.throws(()=>t.audits.rulebooks.assertPayment('local_demo','local','lovelace'),{code:'EVIDENCE_FRESHNESS_REQUIRED'});
    const revision=t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/api/settings',locator:'settings.deposit',captured_at:t.now().toISOString(),method:'api',content_type:'text/plain',content:'Deposit 500 CZK',native_revision:'settings-v1',redacted:true});
    assert.throws(()=>t.audits.recordFreshness(bot,{source_id:revision.source_id,status:'current',method:'api',observed_content:revision.content}),{code:'INVALID_EVIDENCE_CHECK'});
    assert.throws(()=>t.audits.recordFreshness(bot,{source_id:revision.source_id,status:'current',method:'api',observed_content:revision.content,native_revision:'settings-v2'}),{code:'INVALID_EVIDENCE_CHECK'});
    assert.equal(t.audits.recordFreshness(bot,{source_id:revision.source_id,status:'current',method:'api',observed_content:revision.content,native_revision:'settings-v1'}).status,'current');
  }finally{t.db.close();}
});


test('credential redaction applies to capture metadata and proposed profile, not only evidence body',()=>{
  const t=setup();try {
    assert.throws(()=>t.audits.archiveEvidence(bot,{system_id:'workshop-ui',url:'https://workshop.example.test/',locator:'Authorization: Bearer dangerous-private-credential',captured_at:t.now().toISOString(),method:'browser',content_type:'text/plain',content:'Safe redacted body',redacted:true}),{code:'UNREDACTED_EVIDENCE'});
    const r=t.audits.createReport(bot,report(t)),s=submission(t,r.version);s.proposal.profile.summary='Authorization: Bearer dangerous-private-credential';
    assert.throws(()=>t.audits.proposeRulebook(bot,s),{code:'UNREDACTED_EVIDENCE'});
  }finally{t.db.close();}
});

test('owner can revise payment policy without erasing history; new proposal must cite the latest answer',()=>{
  const t=setup(); try {
    const input=report(t);input.questions=[{id:'payment-policy',question:'Which payment provider is authorized?',critical:true,affected_parameters:['provider','network','asset'],citations:[]}];
    const r=t.audits.createReport(bot,input);
    const first=t.audits.answerQuestion(owner,{report_version:r.version,question_id:'payment-policy',answer:'Masumi on Preprod requires a separate live verification.',kind:'policy_decision',scope:'Fictional workshop checkout'});
    const oldBytes=t.db.prepare('SELECT payload_json FROM audit_rulebook_versions WHERE version=?').get(first.version);
    assert.throws(()=>t.audits.answerQuestion(bot,{report_version:r.version,question_id:'payment-policy',answer:'Skip owner policy',kind:'policy_decision',scope:'Checkout'}),{code:'FORBIDDEN'});
    const updated=t.audits.answerQuestion(owner,{report_version:r.version,question_id:'payment-policy',answer:'For this hackathon use local_demo on local with synthetic lovelace; no blockchain transactions.',kind:'policy_decision',scope:'Fictional workshop checkout'});
    const answers=t.audits.context(bot).answers;
    assert.equal(answers.length,2);assert.equal(answers[0]!.version,updated.version);
    assert.deepEqual(t.db.prepare('SELECT payload_json FROM audit_rulebook_versions WHERE version=?').get(first.version),oldBytes);
    assert.equal(t.audits.getEvidence(bot,first.evidence.source_id).hash,first.evidence.hash);
    const stale=submission(t,r.version);
    for(const key of ['provider','network','asset'] as const)stale.proposal.evidence[key]=[cite(first.evidence)];
    stale.source_authority[first.evidence.source_id]='policy_decision';
    const stillBlocked=t.audits.proposeRulebook(bot,stale);
    for(const key of ['provider','network','asset'] as const)assert.ok(stillBlocked.governance!.blocked_parameters.includes(key));
    const current=submission(t,r.version);
    for(const key of ['provider','network','asset'] as const)current.proposal.evidence[key]=[cite(updated.evidence)];
    current.source_authority[updated.evidence.source_id]='policy_decision';
    const next=t.audits.proposeRulebook(bot,current);
    assert.deepEqual(next.governance!.blocked_parameters,[]);
    assert.throws(()=>t.audits.activateRulebook(bot,{version:next.version,payload_hash:next.payload_hash}),{code:'FORBIDDEN'});
    assert.equal(t.audits.rulebooks.list().some(v=>v.status==='active'),false,'Revising an answer or proposing rules never activates them');
  }finally{t.db.close();}
});
