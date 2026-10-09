import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture,onboard,audited,activate,provision,operational,json,service,auditScopes,clock,password } from './handoru-fixture.js';

test('Handle URLs and previous aliases share owner sessions, credentials and firm records', async t => {
  const f = await freshFixture(t);
  const manifest = await json(await f.publicCall('/.well-known/handle.json'));
  assert.deepEqual(await json(await f.publicCall('/.well-known/handoru.json')), manifest);
  assert.equal(manifest.human_console, `${f.base}/handle`);
  for (const path of ['/handle', '/handoru']) {
    const response = await f.publicCall(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Handle/);
  }
  for (const path of ['/handle.css', '/handle.js', '/handle/onboarding', '/skills/handle-onboarding/SKILL.md', '/cli/handle.mjs', '/cli/handoru.mjs']) {
    assert.equal((await f.publicCall(path)).status, 200, path);
  }
  const c = await onboard(f);
  assert.ok(c.registration.verification_url.startsWith(`${f.base}/handle?request=`));
  assert.equal(c.registration.ownership_challenge.path, '/.well-known/handle-ownership.json');
  for (const path of ['/api/handle/v1', '/api/handoru/v1']) {
    const me = await json(await c.agent(`${path}/me`));
    assert.equal(me.business_id, c.businessId);
    assert.equal(me.connection_id, c.connectionId);
    const session = await json(await c.owner.call(`${path}/owner/session`));
    assert.equal(session.owner.id, c.owner.actor.id);
    assert.equal((await c.legacyOwner.call(`${path}/owner/dashboard`)).status, 401);
    assert.equal((await c.agent(`${path}/owner/dashboard`)).status, 403);
    assert.equal((await f.client({cookie:c.owner.cookie})(`${path}/owner/logout`, {})).status, 403);
  }
  assert.deepEqual(await json(await f.publicCall('/.well-known/handle-ownership.json')),
    await json(await f.publicCall('/.well-known/handoru-ownership.json')));
  await json(await c.owner.call('/api/handoru/v1/owner/logout', {}));
  assert.equal((await json(await c.owner.call('/api/handle/v1/owner/session'))).owner, null);
});

test('fresh HTTP onboarding separates legacy admin from human owner and gates real managed relay until approval',async t=>{
  const f=await freshFixture(t,{unified:true});
  assert.equal(f.handoru.installation(),undefined);assert.deepEqual(f.rulebooks.list(),[]);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503);
  const manifest=await json(await f.publicCall('/.well-known/handle.json'));
  assert.equal(manifest.api_base,`${f.base}/api/handle/v1`);assert.equal(manifest.mcp.runtime_support,'verify_with_actual_client');
  const registration=await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:'scripted-regression-runtime',legacy_url:f.base}),201);
  const legacyOwner=await f.login(),owner=await f.signup();
  const decide=`/api/handle/v1/owner/onboarding/${registration.request_id}/decide`,consent={user_code:registration.user_code,decision:'approved',scopes:auditScopes};
  assert.equal((await legacyOwner.call(decide,consent)).status,401,'Broad legacy admin is not human Handle identity');
  assert.equal((await owner.call(decide,consent)).status,409,'Independent owner must also prove website control');
  const c=await onboard(f,{registration,owner});
  assert.equal(c.credential.credential_audience,f.base);assert.deepEqual(c.credential.scopes,auditScopes);
  assert.equal((await c.provisional(`/api/handle/v1/onboarding/${registration.request_id}/credentials`,{})).status,409,'Credential exchange cannot be reused');
  assert.equal((await c.agent('/api/agent/availability')).status,403,'Audit token cannot act as native operator');
  const relay=await provision(c),again=await provision(c);assert.equal(relay.id,again.id);assert.equal(relay.endpoint,`${f.base}/relay/${relay.id}/a2a`);
  assert.equal((await c.agent(`/relay/${relay.id}/bot/inbox`)).status,403,'Managed private inbox enforces operational grant');
  const before=await f.customer(`/relay/${relay.id}/a2a`,{jsonrpc:'2.0',id:1,method:'SendMessage',params:{message:{messageId:'before-activation',role:'user',parts:[{text:'Quote four tyres.'}]}}});
  assert.ok(before.status>=400,'Unapproved managed service refuses customer execution');
  const audit=await audited(f,c);
  const wrong=await c.owner.call(`${c.path}/owner/rulebooks/${audit.proposal.version}/activate`,{payload_hash:'0'.repeat(64)});
  assert.equal(wrong.status,409);
  assert.equal((await c.legacyOwner.call(`/api/admin/rulebooks/${audit.proposal.version}/activate`,{payload_hash:audit.proposal.payload_hash})).status,401,'Old activation alias cannot use legacy admin');
  // Both cookies are present in an ordinary browser. Only the Handle CSRF realm must apply here.
  const mixed=f.client({cookie:`${c.legacyOwner.cookie}; ${c.owner.cookie}`,'x-csrf-token':c.owner.csrf});
  const active=await json(await mixed(`${c.path}/owner/rulebooks/${audit.proposal.version}/activate`,{payload_hash:audit.proposal.payload_hash}));
  assert.equal(active.rulebook.payload_hash,audit.proposal.payload_hash);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503,'Rulebook alone does not publish card');
  const authorized=await operational(c,audit.proposal.payload_hash);assert.equal(authorized.execution_epoch,1);
  const inbox=await json(await c.agent(`/relay/${relay.id}/bot/inbox`));assert.deepEqual(inbox.items,[]);
  const opened=await json(await f.customer('/api/agent/cases',{service_spec:service}),201);
  const quoted=await json(await c.agent(`/api/agent/cases/${opened.case.id}/quotes`,{slot_id:'slot-main',discount_bps:300},{'idempotency-key':'fresh-case-quote'}),201);
  const replay=await json(await c.agent(`/api/agent/cases/${opened.case.id}/quotes`,{slot_id:'slot-main',discount_bps:300},{'idempotency-key':'fresh-case-quote'}),201);
  assert.equal(quoted.quote.id,replay.quote.id);assert.equal(quoted.case.business_id,c.businessId);
  const context=await json(await c.agent(`${c.path}/context`));
  assert.equal(context.business_id,c.businessId);assert.equal(context.rulebooks[0].payload_hash,audit.proposal.payload_hash);assert.equal(context.cases[0].id,opened.case.id);
  assert.equal(context.credentials_included,false);assert.ok(!JSON.stringify(context).includes(c.token));
  assert.equal(context.source_checks.find((s:any)=>s.source_id===audit.policy.source_id).status,'unknown','Archive integrity is not external freshness');
  const capabilities=await json(await c.agent(`${c.path}/capabilities`));assert.equal(capabilities.mcp.runtime_verified,false);
});

test('fresh native checkout requires a human customer mandate and exact owner quote exception',async t=>{
  const f=await freshFixture(t),c=await onboard(f),relay=await provision(c),audit=await audited(f,c);
  assert.ok(relay.endpoint);await activate(c,audit);await operational(c,audit.proposal.payload_hash);
  const human=await f.login('customer-a'),opened=await json(await f.customer('/api/agent/cases',{service_spec:service}),201);
  const quoted=await json(await c.agent(`/api/agent/cases/${opened.case.id}/quotes`,{slot_id:'slot-main',discount_bps:1000},{'idempotency-key':'quote-owner-exception'}),201);
  assert.equal(quoted.approval.status,'pending');
  const mandate=(await json(await f.customer('/api/agent/mandates',{case_id:opened.case.id,mode:'book',service_spec:service,max_total_minor:250000,max_deposit_minor:50000,payment_mode:'deposit',latest_service_end:'2026-10-20T22:00:00Z',expires_at:new Date(clock().getTime()+3600000).toISOString(),allow_extras:false,currency:'CZK',network:'local',asset:'lovelace',max_asset_quantity:'25000000',max_network_fee:'2000000',mapping_version:'demo-map-v1',seller_id:'pneu007-demo'}),201)).mandate;
  assert.equal((await c.agent(`/api/admin/mandates/${mandate.id}/approve`,{})).status,403);
  await json(await human.call(`/api/admin/mandates/${mandate.id}/approve`,{}));
  const accept={quote_id:quoted.quote.id,mandate_id:mandate.id};
  const pending=await f.customer(`/api/agent/cases/${opened.case.id}/accept`,accept);assert.equal(pending.status,403);
  await json(await c.owner.call(`${c.path}/owner/approvals/${quoted.approval.id}/decide`,{decision:'approved'}));
  const accepted=await json(await f.customer(`/api/agent/cases/${opened.case.id}/accept`,accept));
  const purchase=await json(await c.agent(`/api/agent/orders/${accepted.order.id}/checkout`,{}, {'idempotency-key':'fresh-checkout'}));
  const repeated=await json(await c.agent(`/api/agent/orders/${accepted.order.id}/checkout`,{}, {'idempotency-key':'fresh-checkout'}));
  assert.equal(purchase.intent.intent_id,repeated.intent.intent_id);assert.equal(purchase.intent.provider,'local_demo');assert.equal(purchase.simulation,true);
  assert.equal(purchase.booking.status,'confirmed');assert.equal(purchase.intent.authorization.mandate_id,mandate.id);assert.equal(purchase.intent.amount_minor,50000);
  assert.equal(f.store.listPaymentIntents().length,1);assert.equal(f.store.calendar().filter(v=>v.order_id===accepted.order.id).length,1);
});


test('native audit admin revocation invalidates browser cookies and password persistently across restart',async t=>{
  const f=await freshFixture(t),c=await onboard(f);
  assert.equal((await c.legacyOwner.call('/api/admin/orders')).status,200);
  assert.equal((await c.agent(`${c.path}/owner/legacy-access/revoke`,{username:'owner'})).status,403,'Bot cannot receive human replacement credential');
  const rotated=await json(await c.owner.call(`${c.path}/owner/legacy-access/revoke`,{username:'owner'}));
  assert.equal(rotated.state,'verified_revoked');assert.ok(rotated.replacement_password.length>=32);
  assert.equal((await c.legacyOwner.call('/api/admin/orders')).status,401,'Old admin browser cookie was revoked');
  assert.equal((await f.publicCall('/api/login',{username:'owner',password})).status,401,'Old owner password was rotated');
  const replacement=await json(await f.publicCall('/api/login',{username:'owner',password:rotated.replacement_password}));assert.equal(replacement.actor.role,'owner');
  const context=await json(await c.agent(`${c.path}/context`));assert.ok(!JSON.stringify(context).includes(rotated.replacement_password));
  await f.restart();
  assert.equal((await f.publicCall('/api/login',{username:'owner',password})).status,401,'Original environment password must not be reimported on reboot');
  assert.equal((await c.legacyOwner.call('/api/admin/orders')).status,401);
  assert.equal((await f.publicCall('/api/login',{username:'owner',password:rotated.replacement_password})).status,200);
  assert.equal((await c.agent('/api/handle/v1/me')).status,200,'Separate agent service identity persists');
});
