import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture, ready, onboard, probe, json, service, mcp } from './handoru-fixture.js';
import type { Enrollment } from './handoru-fixture.js';
import type { RulebookProposal } from '../../../packages/audit/index.js';

async function nextRulebook(c: Enrollment, previous: any, requiredCapabilities: string[]) {
  const proposal: RulebookProposal = {
    profile: { ...previous.profile, summary: `${previous.profile.summary} Revised review version.` },
    params: previous.params, evidence: previous.evidence, findings: previous.findings,
  };
  const proposed = (await json(await c.agent(`${c.path}/rulebook/proposals`, {
    report_version: previous.governance.report_version, proposal,
    source_authority: previous.governance.source_authority, required_capabilities: requiredCapabilities,
  }), 201)).rulebook;
  await json(await c.owner.call(`${c.path}/owner/rulebooks/${proposed.version}/activate`, {
    payload_hash: proposed.payload_hash,
  }));
  return proposed;
}

test('fresh active business cannot bypass its managed relay through the former standalone endpoints', async t => {
  const f = await freshFixture(t, { unified: true }), a = await ready(f);
  assert.deepEqual((await json(await a.agent(`/relay/${a.relay.id}/bot/inbox`))).items, []);
  for (const path of ['/bot/inbox', '/bot/wait?timeout=0', '/bot/tasks/arbitrary']) {
    const response = await a.agent(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error, 'MANAGED_RELAY_REQUIRED');
  }
  for (const path of ['/bot/reply', '/bot/doorbell', '/a2a/jsonrpc']) {
    const response = await a.agent(path, {});
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error, 'MANAGED_RELAY_REQUIRED');
  }
});

test('a newly approved unsupported capability blocks already-active HTTP, MCP and relay paths after acknowledgement', async t => {
  const f = await freshFixture(t, { unified: true }), a = await ready(f);
  const quoteCount = () => (f.system.store.db.prepare('SELECT COUNT(*) n FROM quotes').get() as { n: number }).n;
  const beforeQuotes = quoteCount();
  const opened = (await json(await f.customer('/api/agent/cases', { service_spec: service }), 201)).case;
  const v2 = await nextRulebook(a, a.audit.proposal, ['unsupported.native-transfer']);
  // Re-acknowledging the new hash must not recover operation privileges by itself.
  await probe(a, v2.payload_hash);
  const availability = await a.agent('/api/agent/availability');
  assert.equal(availability.status, 409);
  assert.equal((await availability.json()).error.code, 'CAPABILITY_UNAVAILABLE');
  const quote = await a.agent(`/api/agent/cases/${opened.id}/quotes`, {
    slot_id: 'slot-main', discount_bps: 300,
  }, { 'idempotency-key': 'unsupported-v2-quote' });
  assert.equal(quote.status, 409);
  assert.equal((await quote.json()).error.code, 'CAPABILITY_UNAVAILABLE');
  const tool = await json(await mcp(f, a.token)('tools/call', { name: 'availability', arguments: {} }));
  assert.equal(tool.result.isError, true);
  assert.match(tool.result.content[0].text, /CAPABILITY_UNAVAILABLE/);
  assert.equal((await a.agent(`/relay/${a.relay.id}/bot/inbox`)).status, 403);
  assert.equal((await a.agent(`/relay/${a.relay.id}/bot/doorbell`, {})).status, 403);
  const context = await json(await a.agent(`${a.path}/context`));
  assert.equal(context.rulebooks.find((r: any) => r.status === 'active').payload_hash, v2.payload_hash);
  assert.equal(quoteCount(), beforeQuotes);
});

test('publication from an older exact rulebook is withdrawn and cannot be rewritten or verified under V2', async t => {
  const f = await freshFixture(t), a = await ready(f);
  const old = await json(await a.agent(`${a.path}/website-publications`, {}, {
    'idempotency-key': 'publication-v1',
  }), 201);
  await json(await a.agent('/api/agent/site/agent-card', { publication_id: old.id }, {
    'idempotency-key': 'site-write-v1',
  }));
  await json(await a.agent(`${a.path}/website-publications/${old.id}/verify`, {}));
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status, 200);
  assert.match(await (await f.publicCall('/')).text(), /handoru-agent-card-link/);
  const v2 = await nextRulebook(a, a.audit.proposal, ['pneu.http']);
  const hidden = await f.publicCall('/.well-known/agent-card.json');
  assert.equal(hidden.status, 503);
  assert.equal((await hidden.json()).error, 'PUBLICATION_STALE');
  assert.doesNotMatch(await (await f.publicCall('/')).text(), /handoru-agent-card-link/);
  await probe(a, v2.payload_hash);
  const rewrite = await a.agent('/api/agent/site/agent-card', { publication_id: old.id }, {
    'idempotency-key': 'site-write-old-under-v2',
  });
  assert.equal(rewrite.status, 409);
  assert.equal((await rewrite.json()).error.code, 'PUBLICATION_STALE');
  const verify = await a.agent(`${a.path}/website-publications/${old.id}/verify`, {});
  assert.equal(verify.status, 409);
  assert.equal((await verify.json()).error.code, 'PUBLICATION_STALE');
  const reuse = await a.agent(`${a.path}/website-publications`, {}, { 'idempotency-key': 'publication-v1' });
  assert.equal(reuse.status, 409);
  assert.equal((await reuse.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  const current = await json(await a.agent(`${a.path}/website-publications`, {}, {
    'idempotency-key': 'publication-v2',
  }), 201);
  await json(await a.agent('/api/agent/site/agent-card', { publication_id: current.id }, {
    'idempotency-key': 'site-write-v2',
  }));
  await json(await a.agent(`${a.path}/website-publications/${current.id}/verify`, {}));
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status, 200);
});

test('bound successor reads the original pending quote and its later human decision without recreating an offer', async t => {
  const f = await freshFixture(t), a = await ready(f);
  const opened = (await json(await f.customer('/api/agent/cases', { service_spec: service }), 201)).case;
  const original = await json(await a.agent(`/api/agent/cases/${opened.id}/quotes`, {
    slot_id: 'slot-main', discount_bps: 1000,
  }, { 'idempotency-key': 'pending-original-quote' }), 201);
  const b = await onboard(f, { owner: a.owner, runtime: 'scripted-pending-successor' });
  const before = await json(await b.agent(`${b.path}/context`));
  assert.deepEqual(before.cases[0].quote, original.quote);
  assert.equal(before.cases[0].approval.id, original.approval.id);
  assert.equal(before.cases[0].approval.status, 'pending');
  assert.equal(before.operations.find((operation: any) => operation.operation_key === 'pending-original-quote').result.quote.id, original.quote.id);
  await json(await a.owner.call(`${a.path}/owner/approvals/${original.approval.id}/decide`, { decision: 'approved' }));
  const after = await json(await b.agent(`${b.path}/context`));
  assert.equal(after.cases[0].quote.id, original.quote.id);
  assert.equal(after.cases[0].quote.price.total_minor, original.quote.price.total_minor);
  assert.equal(after.cases[0].approval.id, original.approval.id);
  assert.equal(after.cases[0].approval.status, 'approved');
  assert.equal(after.cases[0].approval.decided_by, a.owner.actor.id);
  assert.notEqual(after.snapshot_hash,before.snapshot_hash,'Snapshot hash includes the changed quote and human decision');
  const delta=await json(await b.agent(`${b.path}/events?after=${encodeURIComponent(before.cursor)}`));
  assert.ok(delta.events.some((event:any)=>event.kind==='native.agent_approval.approved'),'Delta exposes the actual stored decision');
  assert.equal((await b.agent(`/api/agent/cases/${opened.id}/quotes`, {
    slot_id: 'slot-main', discount_bps: 1000,
  }, { 'idempotency-key': 'candidate-must-not-requote' })).status, 403);
});

test('same customer identity cannot cross the native installation boundary for cases or mandates',async t=>{
  const f=await freshFixture(t),a=await ready(f);
  const own=(await json(await f.customer('/api/agent/cases',{service_spec:service}),201)).case;
  // Explicit foreign tenant fixture; public native case creation cannot select another tenant.
  const foreign={...own,id:'foreign-tenant-case',business_id:'foreign-business'};
  f.system.store.db.prepare('INSERT INTO agent_cases(id,customer_id,customer_agent_id,business_actor_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(foreign.id,foreign.customer_id,foreign.customer_agent_id,foreign.business_actor_id,foreign.status,JSON.stringify(foreign),foreign.created_at,foreign.updated_at);
  assert.equal((await f.customer(`/api/agent/cases/${foreign.id}`)).status,403);
  const listed=await json(await f.customer('/api/agent/cases'));assert.deepEqual(listed.cases.map((c:any)=>c.id),[own.id]);
  assert.equal((await a.agent(`/api/agent/cases/${foreign.id}`)).status,403);
});


test('revoking Handle does not silently revoke independent legacy admin access',async t=>{
  const f=await freshFixture(t),a=await ready(f);
  const revoked=await json(await a.owner.call(`${a.path}/owner/connections/${a.connectionId}/revoke`,{}));
  assert.equal(revoked.external_access_revocation_pending,true);
  assert.equal((await a.agent('/api/agent/cases')).status,401);
  assert.equal((await a.legacyOwner.call('/api/admin/orders')).status,200,'Independent admin session stays live until actually rotated');
  await json(await a.owner.call(`${a.path}/owner/legacy-access/revoke`,{username:'owner'}));
  assert.equal((await a.legacyOwner.call('/api/admin/orders')).status,401);
});

test('unknown managed resource errors remain bounded JSON without internal stacks',async t=>{
  const f=await freshFixture(t,{unified:true});
  const response=await f.publicCall('/relay/not-a-provisioned-resource/a2a');
  assert.equal(response.status,404);assert.match(response.headers.get('content-type')??'',/application\/json/);
  assert.deepEqual(await response.json(),{error:{code:'RELAY_NOT_FOUND',message:'Unknown relay.'}});
});
