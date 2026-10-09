import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture, json, auditScopes, onboard } from './handoru-fixture.js';

function assertNoSecrets(value:unknown,registration:any) {
  const encoded=JSON.stringify(value);
  for(const secret of [registration.ownership_challenge.challenge,registration.provisional_credential,registration.user_code])assert.ok(!encoded.includes(secret));
  for(const field of ['challenge','code_hash','provisional_hash'])assert.ok(!encoded.includes(`"${field}":`));
}

test('missing website proof is visible before the existing human owner is asked to approve', async t => {
  const f = await freshFixture(t);
  const owner = await f.signup();
  const registration = await json(await f.publicCall('/api/handle/v1/agent-registrations', {
    runtime: 'Synthetic ownership prerequisite regression', legacy_url: f.base,
  }), 201);
  const requestPath = `/api/handle/v1/onboarding/${registration.request_id}`;
  const provisional = f.client({ authorization: `Bearer ${registration.provisional_credential}` });
  const decision = `/api/handle/v1/owner/onboarding/${registration.request_id}/decide`;
  const blocked = await json(await owner.call(decision, {
    user_code: registration.user_code, decision: 'approved', scopes: auditScopes,
  }), 409);
  assert.equal(blocked.error.code, 'OWNERSHIP_PROOF_REQUIRED');
  assert.equal((await f.publicCall('/.well-known/handle-ownership.json')).status, 404);
  const status = await json(await provisional(requestPath));
  assert.equal(status.state, 'pending');
  assert.deepEqual(status.ownership_verification, { state: 'required', ready_for_consent: false });
  assert.deepEqual(registration.requested_scopes, auditScopes, 'The bot must not guess initial scopes');
  const review = await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}`));
  assert.deepEqual(review.ownership_verification, status.ownership_verification);
  const dashboard=await json(await owner.call('/api/handle/v1/owner/dashboard'));
  assert.deepEqual(dashboard.requests[0].ownership_verification,status.ownership_verification);
  for(const response of [status,review,dashboard])assertNoSecrets(response,registration);
  const legacyOwner = await f.login();
  await json(await legacyOwner.call('/api/admin/handle-ownership-proof', { challenge: registration.ownership_challenge.challenge }));
  assert.deepEqual((await json(await provisional(requestPath))).ownership_verification, { state: 'verified', ready_for_consent: true });
  const approved = await json(await owner.call(decision, {
    user_code: registration.user_code, decision: 'approved', scopes: auditScopes,
  }));
  assert.equal(approved.state, 'approved');
  assert.equal((await json(await provisional(requestPath))).ownership_verification.ready_for_consent,false,'Decided requests cannot be consented again');
});

test('wrong registration proof remains blocked and status reads create no business authority',async t=>{
  const f=await freshFixture(t),owner=await f.signup(),legacy=await f.login();
  const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'First fixture',legacy_url:f.base}),201);
  const other=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'Other fixture',legacy_url:f.base}),201);
  await json(await legacy.call('/api/admin/handle-ownership-proof',{challenge:other.ownership_challenge.challenge}));
  const snapshot=()=>Object.fromEntries(['handoru_onboarding','handoru_businesses','handoru_memberships','handoru_connections','handoru_credentials','handoru_relays','handoru_events','handoru_meta'].map(table=>[table,f.handoru.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();
  const provisional=f.client({authorization:`Bearer ${registration.provisional_credential}`});
  const status=await json(await provisional(`/api/handle/v1/onboarding/${registration.request_id}`));
  assert.deepEqual(status.ownership_verification,{state:'required',ready_for_consent:false});
  const review=await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}`));
  const dashboard=await json(await owner.call('/api/handle/v1/owner/dashboard'));
  assert.deepEqual(review.ownership_verification,status.ownership_verification);
  assert.deepEqual(dashboard.requests.find((row:any)=>row.id===registration.request_id).ownership_verification,status.ownership_verification);
  assert.deepEqual(snapshot(),before,'Reading readiness must not publish, approve, provision or issue credentials');
  const denial=await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}),409);
  assert.equal(denial.error.code,'OWNERSHIP_PROOF_REQUIRED');
});

test('expired or locked requests never report ready even with the exact published proof',async t=>{
  const f=await freshFixture(t),owner=await f.signup(),legacy=await f.login();
  for(const reason of ['expired','locked']) {
    const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:`Fixture ${reason}`,legacy_url:f.base}),201);
    await json(await legacy.call('/api/admin/handle-ownership-proof',{challenge:registration.ownership_challenge.challenge}));
    if(reason==='expired')f.handoru.db.prepare('UPDATE handoru_onboarding SET expires_at=? WHERE id=?').run(f.handoru.time(),registration.request_id);
    else f.handoru.db.prepare('UPDATE handoru_onboarding SET failures=5 WHERE id=?').run(registration.request_id);
    const review=await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}`));
    assert.deepEqual(review.ownership_verification,{state:'verified',ready_for_consent:false});
    const provisional=f.client({authorization:`Bearer ${registration.provisional_credential}`});
    const denial=await json(await provisional(`/api/handle/v1/onboarding/${registration.request_id}`),401);
    assert.equal(denial.error.code,'ONBOARDING_UNAVAILABLE');
    assert.equal((await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}/ownership-challenge`),409)).error.code,'ONBOARDING_UNAVAILABLE');
    const dashboard=await json(await owner.call('/api/handle/v1/owner/dashboard'));
    const pending=dashboard.requests.find((row:any)=>row.id===registration.request_id);
    if(reason==='expired')assert.equal(pending,undefined);
    else assert.equal(pending.ownership_verification.ready_for_consent,false);
    await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}),409);
  }
});

test('only the existing human business member can skip proof on re-enrollment',async t=>{
  const f=await freshFixture(t),existing=await onboard(f);
  const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'Replacement fixture',legacy_url:f.base}),201);
  const request=`/api/handle/v1/owner/onboarding/${registration.request_id}`;
  const provisional=f.client({authorization:`Bearer ${registration.provisional_credential}`});
  assert.deepEqual((await json(await provisional(`/api/handle/v1/onboarding/${registration.request_id}`))).ownership_verification,{state:'required',ready_for_consent:false},'Provisional agent cannot claim human membership');
  const review=await json(await existing.owner.call(request));
  assert.deepEqual(review.ownership_verification,{state:'not_required',ready_for_consent:true});
  const skipped=await json(await existing.owner.call(`${request}/ownership-challenge`));
  assert.deepEqual(skipped.ownership_verification,review.ownership_verification);
  assertNoSecrets(skipped,registration);
  const dashboard=await json(await existing.owner.call('/api/handle/v1/owner/dashboard'));
  assert.deepEqual(dashboard.requests[0].ownership_verification,review.ownership_verification);
  assertNoSecrets(dashboard,registration);
  const outsider={id:'synthetic-foreign-human',email:'foreign@example.test'};
  f.handoru.db.prepare('INSERT INTO handoru_owners SELECT ?,?,salt,password_hash FROM handoru_owners LIMIT 1').run(outsider.id,outsider.email);
  const session=f.handoru.session(outsider),foreign=f.client({cookie:`handoru_session=${session.token}`,'x-csrf-token':session.csrf});
  assert.equal((await json(await foreign(request),403)).error.code,'FORBIDDEN');
  assert.equal((await json(await foreign(`${request}/ownership-challenge`),403)).error.code,'FORBIDDEN');
  assert.deepEqual((await json(await foreign('/api/handle/v1/owner/dashboard'))).requests,[]);
  assert.equal((await json(await foreign(`${request}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}),403)).error.code,'FORBIDDEN');
  const consent=await json(await existing.owner.call(`${request}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}));
  assert.equal(consent.business_id,existing.businessId);
});

test('legacy and agent credentials cannot read human readiness or approve and CSRF/code checks remain enforced',async t=>{
  const f=await freshFixture(t),owner=await f.signup(),legacy=await f.login();
  const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'Auth separation fixture',legacy_url:f.base}),201);
  const request=`/api/handle/v1/owner/onboarding/${registration.request_id}`;
  const provisional=f.client({authorization:`Bearer ${registration.provisional_credential}`});
  const body={user_code:registration.user_code,decision:'approved',scopes:auditScopes};
  for(const [call,status] of [[legacy.call,401],[provisional,403]] as const) {
    assert.equal((await json(await call(request),status)).error.code,'HUMAN_REQUIRED');
    assert.equal((await json(await call(`${request}/ownership-challenge`),status)).error.code,'HUMAN_REQUIRED');
    assert.equal((await json(await call(`${request}/decide`,body),status)).error.code,'HUMAN_REQUIRED');
  }
  assert.equal((await json(await f.client({cookie:owner.cookie})(`${request}/decide`,body),403)).error.code,'CSRF_REQUIRED');
  await json(await legacy.call('/api/admin/handle-ownership-proof',{challenge:registration.ownership_challenge.challenge}));
  assert.equal((await json(await owner.call(`${request}/decide`,{...body,user_code:'wrong-code'}),403)).error.code,'PAIRING_CODE_INVALID');
  await json(await owner.call(`${request}/decide`,body));
});

test('human can obtain a bounded challenge and separately authenticate to the legacy site before consent',async t=>{
  const f=await freshFixture(t),owner=await f.signup();
  const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'Single instruction human verification fixture',legacy_url:f.base}),201);
  const request=`/api/handle/v1/owner/onboarding/${registration.request_id}`;
  const snapshot=()=>Object.fromEntries(['handoru_onboarding','handoru_businesses','handoru_memberships','handoru_connections','handoru_credentials','handoru_meta'].map(table=>[table,f.handoru.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();
  const proof=await json(await owner.call(`${request}/ownership-challenge`));
  assert.deepEqual(proof,{request_id:registration.request_id,ownership_verification:{state:'required',ready_for_consent:false},legacy_url:f.base,challenge:registration.ownership_challenge.challenge,publication_api:'/api/admin/handle-ownership-proof',public_path:'/.well-known/handle-ownership.json'});
  assert.deepEqual(snapshot(),before,'Challenge delivery does not publish or approve');
  await json(await owner.call(proof.publication_api,{challenge:proof.challenge}),401);
  assert.equal((await f.publicCall(proof.public_path)).status,404,'Handle session cannot authorize native publication');
  const legacy=await f.login();
  await json(await f.client({cookie:legacy.cookie})(proof.publication_api,{challenge:proof.challenge}),403);
  await json(await legacy.call(proof.publication_api,{challenge:proof.challenge}));
  assert.equal((await json(await f.publicCall(proof.public_path))).challenge,proof.challenge);
  const verified=await json(await owner.call(`${request}/ownership-challenge`));
  assert.deepEqual(verified,{request_id:registration.request_id,ownership_verification:{state:'verified',ready_for_consent:true}});
  assertNoSecrets(verified,registration);
  assert.equal(f.handoru.installation(),undefined,'Legacy ownership proof cannot approve a Handle connection');
  const approved=await json(await owner.call(`${request}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}));
  assert.equal(approved.state,'approved');
  assert.equal((await json(await owner.call(`${request}/ownership-challenge`),409)).error.code,'ONBOARDING_UNAVAILABLE');
});

test('bootstrap advertises exact initial scopes and proof before consent without changing G0 phases',async t=>{
  const f=await freshFixture(t),manifest=await json(await f.publicCall('/.well-known/handle.json'));
  assert.equal(manifest.version,'1.3');
  assert.deepEqual(manifest.pairing.initial_scopes,auditScopes);
  assert.equal(manifest.pairing.ownership_proof_before_consent.required,true);
  assert.equal(manifest.pairing.ownership_proof_before_consent.publication_api,'/api/admin/handle-ownership-proof');
  const probe=manifest.operations.find((operation:any)=>operation.path==='/businesses/:businessId/relay/probe');
  assert.ok(probe.phases.onboarding);
  assert.ok(probe.phases.rulebook);
});
