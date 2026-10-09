import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture,onboard,audited,activate,provision,operational,json } from './handoru-fixture.js';

const proofPath='/.well-known/business-registry-verification.json';
const proof={business_id:'12345678-1234-4234-8234-123456789012',challenge:'registry-challenge-0123456789-0123456789'};
test('owner-scoped business service publishes only fixed registry proof with restart persistence',async t=>{
  const f=await freshFixture(t),c=await onboard(f);
  assert.equal((await f.publicCall(proofPath)).status,404);
  assert.equal((await f.publicCall('/api/agent/registry-proof',proof)).status,401);
  assert.equal((await f.customer('/api/agent/registry-proof',proof)).status,403);
  assert.equal((await c.agent('/api/agent/registry-proof',proof)).status,403,'Audit-only connection cannot publish registry proof');
  const audit=await audited(f,c);await activate(c,audit);await provision(c);await operational(c,audit.proposal.payload_hash,['cases.quote','orders.checkout','inbox.claim','inbox.reply','registry.publish']);
  for(const input of [null,[],{...proof,token:'forbidden'},{...proof,business_id:'invalid'},{...proof,challenge:'short'}]){
    assert.equal((await c.agent('/api/agent/registry-proof',input)).status,400);
  }
  await json(await c.agent('/api/agent/registry-proof',proof));
  const publicResponse=await f.publicCall(proofPath);assert.equal(publicResponse.headers.get('cache-control'),'no-store');
  assert.deepEqual(await publicResponse.json(),proof);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503,'Registry proof does not publish the Agent Card');
  const replacement={...proof,challenge:'replacement-registry-challenge-0123456789'};
  await json(await c.agent('/api/agent/registry-proof',replacement));await f.restart();
  assert.deepEqual(await (await f.publicCall(proofPath)).json(),replacement);
  assert.deepEqual(f.system.store.db.prepare('SELECT COUNT(*) n FROM business_registry_proof').get(),{n:1});
  assert.ok(!JSON.stringify(await (await f.publicCall(proofPath)).json()).includes(c.token));
});

test('old static-token enrollment is replaced by fresh agent-initiated registration',async t=>{
  const f=await freshFixture(t),legacy=await f.login();
  const removed=await f.publicCall('/api/admin/agent-enrollments',{});assert.equal(removed.status,410);
  assert.deepEqual(await removed.json(),{error:'ENROLLMENT_REPLACED',bootstrap:'/.well-known/handle.json'});
  assert.equal((await legacy.call('/api/admin/agent-enrollments',{})).status,410);
  const url=`/agent-enrollments/${'x'.repeat(43)}`;
  assert.equal((await f.publicCall(url)).status,405);
  const redeem=await f.publicCall(url,{});assert.equal(redeem.status,410);
  assert.ok(!JSON.stringify(await redeem.json()).includes('access_token'));
  const registration=await json(await f.publicCall('/api/handoru/v1/agent-registrations',{runtime:'scripted-registration-fixture',legacy_url:f.base}),201);
  assert.ok(registration.provisional_credential);
  assert.equal(f.handoru.installation(),undefined);assert.deepEqual(f.handoru.db.prepare('SELECT COUNT(*) n FROM handoru_credentials').get(),{n:0});
});
