import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture, onboard, provision, json, audited, activate, probe, ready, operationScopes } from './handoru-fixture.js';
import type { Enrollment } from './handoru-fixture.js';

const evidence='Synthetic HTTP client received the private onboarding probe; not live GrokBot evidence.';
async function start(c:Enrollment,phase:'onboarding'|'rulebook'='onboarding') {
  const started=await json(await c.agent(`${c.path}/relay/probe`,{phase}),201);
  const inbox=await json(await c.agent(`${c.path}/relay/probe/inbox`));
  assert.equal(started.phase,phase);
  assert.equal(inbox.phase,phase);
  return {nonce:inbox.items[0].nonce,method:'polling',evidence};
}

test('fresh G0 survives restart and answers before any audit or active rulebook without granting operation authority', async t => {
  const f=await freshFixture(t,{unified:true});
  // The human account already exists before the fresh agent begins.
  const owner=await f.signup(),c=await onboard(f,{owner}),relay=await provision(c);
  assert.deepEqual(f.rulebooks.list(),[]);
  const before=await json(await c.agent('/api/handle/v1/me'));
  const answer=await start(c);
  await f.restart();
  const inbox=await json(await c.agent(`${c.path}/relay/probe/inbox`));
  assert.equal(inbox.items[0].nonce,answer.nonce);
  const result=await json(await c.agent(`${c.path}/relay/probe/answer`,answer));
  assert.equal(result.probe_passed,true);
  assert.equal(result.phase,'onboarding');
  assert.equal(result.operation_ready,false);
  assert.equal(result.rulebook_hash,undefined);
  assert.deepEqual(f.system.rulebooks.list(),[],'G0 must not seed an audit or activate rules');
  assert.deepEqual(await json(await c.agent('/api/handle/v1/me')),before,'G0 must not grant scopes or change active execution');
  assert.equal((await json(await c.agent(`${c.path}/relay`))).probe_passed,0);
  await f.restart();
  const capabilities=await json(await c.agent(`${c.path}/capabilities`));
  assert.deepEqual(capabilities.onboarding_readiness,result,'The separate onboarding result persists');
  assert.equal(capabilities.readiness,null);
  assert.equal((await c.agent(`/relay/${relay.id}/bot/inbox`)).status,403,'G0 grants no customer-work scope');
  assert.equal((await c.agent('/api/agent/availability')).status,403);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503);
  const authorize=`${c.path}/owner/connections/${c.connectionId}/authorize-operation`;
  assert.equal((await json(await owner.call(authorize,{scopes:operationScopes,expected_epoch:0}),409)).error.code,'RULEBOOK_INACTIVE');
  const audit=await audited(f,c);
  await activate(c,audit);
  assert.equal((await json(await owner.call(authorize,{scopes:operationScopes,expected_epoch:0}),409)).error.code,'CAPABILITY_PROBE_REQUIRED','G0 cannot become policy readiness merely by activating rules');
  assert.equal((await c.agent('/api/agent/availability')).status,403);
  assert.equal((await c.agent(`${c.path}/website-publications`,{}, {'idempotency-key':'g0-no-publication'})).status,403);
  await probe(c,audit.proposal.payload_hash);
  await json(await owner.call(authorize,{scopes:operationScopes,expected_epoch:0}));
  assert.equal((await c.agent('/api/agent/availability')).status,200,'The separate existing policy probe still enables human authorization');
});

test('G0 challenges fence phase, connection, superseded nonce, single use, expiry and revocation',async t=>{
  const f=await freshFixture(t),a=await onboard(f),b=await onboard(f,{owner:a.owner,runtime:'synthetic-candidate-B'});
  await provision(a);
  assert.equal((await json(await a.agent(`${a.path}/relay/probe`,{phase:'unknown'}),400)).error.code,'INVALID_PROBE_PHASE');
  const first=await start(a),second=await start(b);
  assert.equal((await b.agent(`${b.path}/relay/probe/answer`,first)).status,409,'A nonce cannot answer B challenge');
  assert.equal((await a.agent(`${a.path}/relay/probe/inbox?phase=rulebook`)).status,409);
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,{...first,phase:'rulebook'})).status,409,'Caller cannot relabel a stored onboarding challenge');
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,{...first,method:'invented'})).status,400);
  const replacement=await start(a);
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,first)).status,409,'Restarting the probe invalidates its prior nonce');
  const attempts=await Promise.all([a.agent(`${a.path}/relay/probe/answer`,replacement),a.agent(`${a.path}/relay/probe/answer`,replacement)]);
  assert.deepEqual(attempts.map(response=>response.status).sort(),[200,409],'Concurrent answers consume a successful nonce once');
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,replacement)).status,409,'Successful nonce is one use');
  assert.equal((await a.agent(`${a.path}/relay/probe/inbox`)).status,409,'Completed nonce is no longer readable');
  // Move only the synthetic challenge to the expiry boundary; the fixture clock remains deterministic.
  f.system.store.db.prepare("UPDATE handoru_meta SET value=json_set(value,'$.created_at',json_extract(value,'$.created_at')-300000) WHERE key=?").run(`probe:${b.connectionId}`);
  assert.equal((await b.agent(`${b.path}/relay/probe/inbox`)).status,409);
  assert.equal((await b.agent(`${b.path}/relay/probe/answer`,second)).status,409);
  const revoked=await start(b);
  await json(await a.owner.call(`${a.path}/owner/connections/${b.connectionId}/revoke`,{}));
  for(const [path,body] of [[`${b.path}/relay/probe`,{phase:'onboarding'}],[`${b.path}/relay/probe/inbox`,undefined],[`${b.path}/relay/probe/answer`,revoked]] as const)assert.equal((await b.agent(path,body)).status,401);
  await f.restart();
  assert.equal((await b.agent(`${b.path}/relay/probe/answer`,revoked)).status,401);
});

test('candidate G0 preserves active policy readiness and cannot satisfy handover; default rulebook probe still checks the exact hash',async t=>{
  const f=await freshFixture(t),a=await ready(f),b=await onboard(f,{owner:a.owner,runtime:'synthetic-successor-B'});
  const activeBefore=await json(await a.agent(`${a.path}/capabilities`)),relayBefore=await json(await a.agent(`${a.path}/relay`));
  const candidate=await start(b);
  await json(await b.agent(`${b.path}/relay/probe/answer`,candidate));
  assert.deepEqual((await json(await a.agent(`${a.path}/capabilities`))).readiness,activeBefore.readiness);
  assert.deepEqual(await json(await a.agent(`${a.path}/relay`)),relayBefore,'Candidate G0 never resets active relay flags');
  assert.equal((await json(await a.owner.call(`${a.path}/owner/handoffs`,{source_connection_id:a.connectionId,target_connection_id:b.connectionId,expected_epoch:1,rulebook_hash:a.audit.proposal.payload_hash,external_access:[]}),409)).error.code,'CAPABILITY_PROBE_REQUIRED');
  await json(await a.agent(`${a.path}/relay/probe`,{}),201); // Existing clients default to policy-bound readiness.
  const inbox=await json(await a.agent(`${a.path}/relay/probe/inbox`));
  assert.equal(inbox.phase,'rulebook');
  const answer={nonce:inbox.items[0].nonce,method:'polling',evidence};
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,{...answer,phase:'onboarding'})).status,409,'Caller cannot downgrade a policy challenge');
  assert.equal((await json(await a.agent(`${a.path}/relay/probe/answer`,{...answer,rulebook_hash:'wrong'}),409)).error.code,'RULEBOOK_HASH_MISMATCH');
  // An in-flight probe from the previous manifest has no stored phase; it remains rulebook-bound.
  f.system.store.db.prepare("UPDATE handoru_meta SET value=json_remove(value,'$.phase') WHERE key=?").run(`probe:${a.connectionId}`);
  const nextCandidate=await start(b);
  await json(await b.agent(`${b.path}/relay/probe/answer`,nextCandidate));
  const accepted=await json(await a.agent(`${a.path}/relay/probe/answer`,{...answer,rulebook_hash:a.audit.proposal.payload_hash}));
  assert.equal(accepted.phase,'rulebook');
  assert.equal(accepted.rulebook_hash,a.audit.proposal.payload_hash,'Candidate onboarding does not invalidate active policy challenge');
  assert.equal((await json(await a.agent(`${a.path}/relay`))).probe_passed,1);
  assert.equal((await a.agent(`${a.path}/relay/probe/answer`,{...answer,rulebook_hash:a.audit.proposal.payload_hash})).status,409);
});
