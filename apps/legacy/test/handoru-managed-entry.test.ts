// Synthetic local HTTP coverage; this does not prove a real GrokBot runtime.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacy } from '../src/server.js';
import { loadLegacyConfig } from '../src/config.js';
import { handoruManifest } from '../src/handoru/manifest.js';
import { auditScopes, json } from './handoru-fixture.js';

async function openFixture(t:TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'handle-managed-entry-')),server=createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config=loadLegacyConfig({NODE_ENV:'production',LEGACY_PUBLIC_URL:base,LEGACY_PORT:'0',LEGACY_DB_PATH:join(directory,'legacy.sqlite'),LEGACY_RECONCILIATION_MS:'0',
    DEMO_OPEN_BUSINESS:'true',DEMO_PUBLIC_A2A:'true',DEMO_CHAT_APPROVAL:'true',PAYMENT_PROVIDER:'local_demo',
    LEGACY_OWNER_PASSWORD:'synthetic-owner-password-0123456789',LEGACY_STAFF_PASSWORD:'synthetic-staff-password-0123456789',LEGACY_CUSTOMER_A_PASSWORD:'synthetic-customer-a-password-0123456789',LEGACY_CUSTOMER_B_PASSWORD:'synthetic-customer-b-password-0123456789',
    LEGACY_BUSINESS_AGENT_TOKEN:'synthetic-business-token-0123456789',LEGACY_CUSTOMER_AGENT_A_TOKEN:'synthetic-customer-a-token-0123456789',LEGACY_CUSTOMER_AGENT_B_TOKEN:'synthetic-customer-b-token-0123456789',LEGACY_RELAY_ADMIN_TOKEN:'synthetic-relay-admin-token-0123456789'});
  const system=createLegacy(config);
  server.on('request',system.app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await system.close();rmSync(directory,{recursive:true,force:true});});
  const call=(path:string,body?:unknown)=>fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  return {base,call,system};
}

test('explicit managed bootstrap coexists with the unchanged open demo contract',async t=>{
  const f=await openFixture(t);
  const standard=await json(await f.call('/.well-known/handle.json'));
  assert.equal(standard.setup_mode,'open_demo');
  assert.equal(standard.authentication,'none');
  assert.equal(standard.owner_approval_required,false);
  assert.equal(standard.pairing,undefined);
  assert.equal(standard.managed_bootstrap_url,`${f.base}/.well-known/handle-managed.json`);
  assert.deepEqual(standard,handoruManifest(f.base,true,true,true));
  const response=await f.call('/.well-known/handle-managed.json');
  const managed=await json(response);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(managed.version,'1.3');
  assert.equal(managed.setup_mode,'managed');
  for(const flag of ['owner_approval_required','ownership_proof_required','fresh_audit_required'])assert.equal(managed[flag],true,flag);
  assert.equal(managed.api_base,`${f.base}/api/handle/v1`);
  assert.deepEqual(managed.pairing.initial_scopes,auditScopes);
  assert.ok(managed.audit_evidence_schema);
  assert.ok(managed.audit_report_schema);
  assert.ok(managed.rulebook_submission_schema);
  assert.equal(managed.authentication,undefined);
  assert.equal(managed.connect,undefined);
  assert.equal(managed.agent_entry_points.business.setup_mode,'managed');
  assert.equal(managed.agent_entry_points.business.bootstrap_url,standard.managed_bootstrap_url);
  assert.deepEqual(managed.agent_entry_points.customer,handoruManifest(f.base,true,true,false).agent_entry_points.customer);
  assert.equal(managed.instructions_url,`${f.base}/handle/agents.md`);
  assert.equal(managed.agent_entry_points.instructions_url,managed.instructions_url);
  assert.equal(managed.skill_url,`${f.base}/skills/handle-onboarding/SKILL.md?setup_mode=managed`);
  assert.equal(managed.agent_entry_points.business.onboarding_skill_url,managed.skill_url);
  for(const url of [managed.instructions_url,managed.skill_url])assert.equal((await fetch(url)).status,200,url);
  const defaultGuide=await(await f.call('/agents.md')).text();
  assert.match(defaultGuide,/Open demo fast path: skip owner onboarding/);
  const managedGuide=await(await f.call('/handle/agents.md')).text();
  assert.match(managedGuide,/handle-managed\.json/);
  assert.doesNotMatch(managedGuide,/## Open demo fast path: skip owner onboarding/);
});

test('managed discovery reads grant no authority or state changes even when open demo is configured',async t=>{
  const f=await openFixture(t);
  const snapshot=()=>Object.fromEntries(['handoru_onboarding','handoru_businesses','handoru_memberships','handoru_principals','handoru_connections','handoru_credentials','handoru_relays','handoru_events','handoru_meta','audit_rulebook_versions'].map(table=>[table,f.system.handoru.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();
  for(const path of ['/.well-known/handle.json','/.well-known/handle-managed.json','/handle/agents.md','/skills/handle-onboarding/SKILL.md?setup_mode=managed'])assert.equal((await f.call(path)).status,200,path);
  assert.equal((await f.call('/api/handle/v1/me')).status,401);
  assert.equal((await f.call('/api/handle/v1/owner/dashboard')).status,401);
  assert.equal((await f.call('/api/handle/v1/businesses/pneu007/relay',{})).status,401);
  assert.equal((await f.call('/api/handle/v1/businesses/pneu007/rulebook/proposals',{})).status,401);
  assert.equal((await f.call('/api/admin/handle-ownership-proof',{challenge:'A'.repeat(43)})).status,401);
  assert.deepEqual(snapshot(),before,'Discovery cannot convert the prepared demo or create managed authority');
  assert.equal((await json(await f.call('/.well-known/handle.json'))).setup_mode,'open_demo');
});
