// Local synthetic regression: prepared public demo and private managed context share an installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Citation, RulebookProposal } from '../../../packages/audit/index.js';
import { importCompatibility } from '../src/handoru/onboarding.js';
import { ALL_SCOPES } from '../src/handoru/store.js';
import { freshFixture, json, onboard, audited, activate, provision } from './handoru-fixture.js';

async function prepared(t:Parameters<typeof freshFixture>[0]) {
  const f=await freshFixture(t,{unified:true}),token='synthetic-public-demo-compatibility-0123456789';
  Object.assign(f.cfg.env,{HANDORU_FRESH:'false',DEMO_OPEN_BUSINESS:'true',DEMO_PUBLIC_A2A:'true',DEMO_CHAT_APPROVAL:'true',LEGACY_BUSINESS_AGENT_TOKEN:token});
  importCompatibility(f.handoru,new Map([[token,{id:'garage-demo',role:'business_agent'}]]),false);
  const sources=f.policy.rulebooks.sources;
  const cite=(id:string):Citation=>{const s=sources.get(id);return {source_id:id,version:s.version,hash:s.hash,excerpt:s.content};};
  const params=sources.config(),operations=['auto_discount_bps','owner_approval_limit_bps','hard_discount_limit_bps','offer_ttl_seconds','deposit_minor'];
  const proposal:RulebookProposal={params,evidence:Object.fromEntries(Object.keys(params).map(key=>[key,[cite(key==='supplier_allowed_actions'?'internal-partners':operations.includes(key)?'internal-operations':'internal-systems')]])) as RulebookProposal['evidence'],profile:{name:'Prepared synthetic shop',summary:'Public prepared test context',systems:['legacy'],partners:['Synthetic supplier'],channels:['A2A'],citations:[cite('internal-systems')]},findings:[]};
  const rule=f.policy.rulebooks.propose({id:'garage-demo',role:'business_agent'},proposal);
  f.policy.rulebooks.activate({id:'staff-owner',role:'owner'},rule.version);
  f.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
  f.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
  return {...f,token};
}

test('activating managed governance closes all anonymous business tools before replacing compatibility actor',async t=>{
  const f=await prepared(t);
  assert.equal((await json(await f.publicCall('/.well-known/handle.json'))).setup_mode,'open_demo');
  assert.equal((await f.publicCall('/demo-business/rulebook')).status,200,'Prepared demo remains usable before transition');
  const c=await onboard(f),a=await audited(f,c);
  assert.equal(c.businessId,'pneu007');
  await activate(c,a);
  assert.equal(f.handoru.business('pneu007').active_connection_id,'compatibility-pneu007','Leak must close immediately at rule activation');
  const privateMarker='Owner policy: agent may discount up to 3 percent; owner approves exceptions up to 10 percent.';
  const context=await json(await c.agent(`${c.path}/context`));
  assert.ok(JSON.stringify(context).includes(privateMarker),'Authenticated own context retains private evidence');
  const anonymousRulebook=await f.publicCall('/demo-business/rulebook');
  assert.ok(!(await anonymousRulebook.text()).includes(privateMarker),'Private managed citations must not leak through the public compatibility facade');
  assert.equal(anonymousRulebook.status,404);
  const snapshot=()=>Object.fromEntries(['handoru_onboarding','handoru_connections','handoru_credentials','handoru_memberships','handoru_operations','handoru_meta','handoru_events','audit_rulebook_versions'].map(table=>[table,f.handoru.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();
  for(const [path,body] of [['/connect',{}],['/profile',undefined],['/catalog',undefined],['/rulebook',undefined],['/schedule',undefined],['/cases',undefined],['/cases/private/quotes',{}],['/orders/private',undefined],['/reservations',undefined],['/bot/inbox',undefined],['/bot/wait',undefined],['/bot/reply',{}],['/bot/scheduled-check-in',{}],['/bot/availability',undefined]] as const) {
    const response=await f.publicCall(`/demo-business${path}`,body);
    assert.equal(response.status,404,path);
    assert.ok(!(await response.text()).includes(privateMarker),path);
  }
  const manifest=await json(await f.publicCall('/.well-known/handle.json'));
  assert.equal(manifest.setup_mode,'managed');
  assert.equal(manifest.owner_approval_required,true);
  assert.doesNotMatch(await(await f.publicCall('/agents.md')).text(),/## Open demo fast path/);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503,'Managed activation requires managed publication');
  assert.deepEqual(snapshot(),before,'Anonymous reads and denied writes cannot alter managed state');
  await provision(c);
  const compat=f.client({authorization:`Bearer ${f.token}`});
  const publication=await json(await compat(`${c.path}/website-publications`,{}, {'idempotency-key':'managed-privacy-card'}),201);
  const descriptor=JSON.parse(publication.descriptor_json);
  assert.notEqual(descriptor.capabilities.extensions[0].params.business.setup_mode,'open_demo');
  assert.ok(!JSON.stringify(descriptor).includes(privateMarker));
  await json(await compat('/api/agent/site/agent-card',{publication_id:publication.id},{'idempotency-key':'managed-privacy-publish'}));
  const card=await json(await f.publicCall('/.well-known/agent-card.json'));
  assert.deepEqual(card,descriptor,'Only the authorized managed publication becomes the public card');
  assert.notEqual(card.capabilities.extensions[0].params.business.setup_mode,'open_demo');
  assert.equal(card.capabilities.extensions[0].params.customer.demo_public_a2a,true,'Public customer demo metadata stays available');
});

test('a non-compatibility active connection disables public business facade without relying on governance',async t=>{
  const f=await prepared(t),c=await onboard(f);
  f.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id=?").run(JSON.stringify(ALL_SCOPES),c.connectionId);
  f.handoru.db.prepare('UPDATE handoru_businesses SET active_connection_id=? WHERE id=?').run(c.connectionId,c.businessId);
  assert.equal((await f.publicCall('/demo-business/rulebook')).status,404);
  assert.equal((await f.publicCall('/demo-business/bot/inbox')).status,404);
  assert.equal((await json(await f.publicCall('/.well-known/handle.json'))).setup_mode,'managed');
});
