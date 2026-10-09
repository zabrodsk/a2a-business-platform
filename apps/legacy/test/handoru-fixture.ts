// Scripted HTTP regression fixtures. These do not prove any external GrokBot runtime or real payment.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLegacyConfig } from '../src/config.js';
import { createLegacy } from '../src/server.js';
import { createUnifiedSystem } from '../src/system.js';
import { LocalDemoProvider } from '../../../packages/payments/index.js';
import { rulebookFields, type Source, type Citation, type RulebookProposal } from '../../../packages/audit/index.js';
import type { AuditReportInput } from '../src/handoru/audits.js';
import type { ServiceSpec } from '../../../packages/contracts/index.js';

export const clock=()=>new Date('2026-10-09T08:00:00.000Z');
export const password='synthetic-test-human-password-0123456789';
export const setupSecret='synthetic-test-independent-owner-setup-0123456789';
export const customerToken='synthetic-test-customer-a-token-0123456789';
export const customerBToken='synthetic-test-customer-b-token-0123456789';
export const service:ServiceSpec={service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4};
export const auditScopes=['audit.read','audit.propose','questions.create','relay.provision','context.read'];
export const operationScopes=['cases.quote','orders.checkout','inbox.claim','inbox.reply','website.agent-card.publish'];
export type Client=(path:string,body?:unknown,headers?:Record<string,string>)=>Promise<Response>;
export async function json(response:Response,status=200):Promise<any> {
  assert.equal(response.status,status,await response.clone().text()); return response.json();
}
async function listen(server:Server) {
  server.listen(0,'127.0.0.1');await new Promise<void>((done,reject)=>{server.once('listening',done);server.once('error',reject);});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server:Server) { server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())); }
export async function freshFixture(t:TestContext,options:{unified?:boolean}={}) {
  const dir=mkdtempSync(join(tmpdir(),'handoru-fresh-http-'));
  // Bind first so the configured public/managed URLs already use the real port. No port reservation race.
  const server=createServer(),base=await listen(server);
  const externalAdmin=createServer((_req,res)=>res.setHeader('content-type','text/html; charset=utf-8').end('<!doctype html><html><h1>Independent legacy admin — synthetic test fixture</h1><p>Owner policy: agent may discount up to 3 percent; owner approves exceptions up to 10 percent. Offer lifetime 1200 seconds. Deposit 500 CZK. Only tyre change and wheel swap, four wheels. No extras. CZK, local_demo, local network, lovelace. Supplier reads: catalogue only.</p></html>'));
  const externalAdminUrl=await listen(externalAdmin);
  const cfg=loadLegacyConfig({NODE_ENV:'production',HANDLE_FRESH:'true',HANDLE_OWNER_SETUP_SECRET:setupSecret,LEGACY_PORT:String((server.address() as AddressInfo).port),LEGACY_PUBLIC_URL:base,
    LEGACY_DB_PATH:join(dir,'legacy.sqlite'),LEGACY_RELAY_DB_PATH:join(dir,'relay.sqlite'),LEGACY_RECONCILIATION_MS:'0',LEGACY_RELAY_REPLY_WAIT_MS:'150',LEGACY_RELAY_RERING_MS:'60000',
    LEGACY_OWNER_PASSWORD:password,LEGACY_STAFF_PASSWORD:password,LEGACY_CUSTOMER_A_PASSWORD:password,LEGACY_CUSTOMER_B_PASSWORD:password,
    LEGACY_CUSTOMER_AGENT_A_TOKEN:customerToken,LEGACY_CUSTOMER_AGENT_B_TOKEN:customerBToken,LEGACY_RELAY_ADMIN_TOKEN:'synthetic-test-relay-admin-0123456789',PAYMENT_PROVIDER:'local_demo'});
  const opts={now:clock,paymentProvider:new LocalDemoProvider({now:clock})};
  let current=options.unified?await createUnifiedSystem(cfg,opts):createLegacy(cfg,opts);
  const system=current;
  server.on('request',system.app);
  const restart=async()=>{server.removeAllListeners('request');await current.close();current=options.unified?await createUnifiedSystem(cfg,opts):createLegacy(cfg,opts);server.on('request',current.app);return current;};
  t.after(async()=>{await close(server);await close(externalAdmin);await current.close();rmSync(dir,{recursive:true,force:true});});
  const client=(headers:Record<string,string>={}):Client=>(path,body,extra={})=>fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const publicCall=client();
  const session=(response:Response,data:any)=>{
    const cookie=response.headers.get('set-cookie')!.split(';')[0]!;
    return {cookie,csrf:data.csrf_token,actor:data.actor??data.owner,call:client({cookie,'x-csrf-token':data.csrf_token})};
  };
  const login=async(username='owner')=>{const response=await publicCall('/api/login',{username,password}),data=await json(response);return session(response,data);};
  const signup=async()=>{const response=await publicCall('/api/handle/v1/owner/signup',{email:'owner@example.test',password,setup_secret:setupSecret}),data=await json(response,201);return session(response,data);};
  return {...system,get system(){return current;},restart,cfg,base,server,externalAdminUrl,client,publicCall,login,signup,
    customer:client({authorization:`Bearer ${customerToken}`}),customerB:client({authorization:`Bearer ${customerBToken}`})};
}
export type FreshFixture=Awaited<ReturnType<typeof freshFixture>>;
export async function onboard(f:FreshFixture,options:{registration?:any;owner?:Awaited<ReturnType<FreshFixture['signup']>>;runtime?:string}={}) {
  const registration=options.registration??await json(await f.publicCall('/api/handle/v1/agent-registrations',{runtime:options.runtime??'scripted-test-runtime-A',legacy_url:f.base}),201);
  const owner=options.owner??await f.signup(),legacyOwner=await f.login();
  await json(await legacyOwner.call('/api/admin/handle-ownership-proof',{challenge:registration.ownership_challenge.challenge}));
  const consent=await json(await owner.call(`/api/handle/v1/owner/onboarding/${registration.request_id}/decide`,{user_code:registration.user_code,decision:'approved',scopes:auditScopes}));
  const provisional=f.client({authorization:`Bearer ${registration.provisional_credential}`});
  const credential=await json(await provisional(`/api/handle/v1/onboarding/${registration.request_id}/credentials`,{}));
  const agent=f.client({authorization:`Bearer ${credential.access_token}`});
  return {registration,owner,legacyOwner,provisional,credential,agent,token:credential.access_token as string,businessId:consent.business_id as string,connectionId:consent.connection_id as string,path:`/api/handle/v1/businesses/${consent.business_id}`};
}
export type Enrollment=Awaited<ReturnType<typeof onboard>>;
function cite(source:Source):Citation { return {source_id:source.source_id,version:source.version,hash:source.hash,excerpt:source.content}; }
export async function audited(f:FreshFixture,c:Enrollment) {
  // Explicit test-authored interpretation, using captures read from two independent running HTTP systems.
  const external=await(await fetch(f.externalAdminUrl)).text(),catalog=await(await f.publicCall('/api/services')).text();
  const policy=(await json(await c.agent(`${c.path}/audit-evidence`,{system_id:'independent_legacy',url:f.externalAdminUrl,locator:'Operations policy paragraph in browser-only legacy admin',captured_at:clock().toISOString(),method:'browser',content_type:'text/plain',content:external,redacted:true}),201)).evidence as Source;
  const services=(await json(await c.agent(`${c.path}/audit-evidence`,{system_id:'native_pneu',url:`${f.base}/api/services`,locator:'GET /api/services',captured_at:clock().toISOString(),method:'api',content_type:'application/json',content:catalog,redacted:true}),201)).evidence as Source;
  const report:AuditReportInput={schema_version:'1.0',title:'Explicit scripted test audit',summary:'Synthetic test-authored interpretation of captured browser-only and native API systems; not external runtime proof.',systems:[
    {id:'native_pneu',name:'Native Pneu fixture',url:f.base,purpose:'Orders, availability and checkout authority',access_methods:['browser','api','mcp'],observed_roles:['admin','service agent'],fact_authority:['Native records and backend policy enforcement']},
    {id:'independent_legacy',name:'Independent browser-only legacy fixture',url:f.externalAdminUrl,purpose:'Observed policy documents',access_methods:['browser'],observed_roles:['administrator'],fact_authority:['Owner reviews proposed policy authority']}],processes:[{id:'tyre-service',description:'Read catalogue; quote service and book only with customer mandate.',citations:[cite(services)]}],findings:[],questions:[],supported_writes:[{action:'quote.create',system_id:'native_pneu',mode:'native_enforced',description:'Test the actual native HTTP and MCP policy path separately.',citations:[cite(services)]}]};
  const saved=(await json(await c.agent(`${c.path}/audit-reports`,report),201)).report;
  const params:RulebookProposal['params']={auto_discount_bps:300,owner_approval_limit_bps:1000,hard_discount_limit_bps:1000,offer_ttl_seconds:1200,deposit_minor:50000,allowed_services:['tyre_change','wheel_swap'],currency:'CZK',allow_extras:false,provider:'local_demo',network:'local',asset:'lovelace',supplier_allowed_actions:['catalog.read']};
  const proposal:RulebookProposal={profile:{name:'Pneu 007 (fictional)',summary:'Explicit synthetic audited profile',systems:['Native Pneu fixture','Independent legacy fixture'],partners:['Fictional supplier'],channels:['web','A2A'],citations:[cite(services),cite(policy)]},params,evidence:Object.fromEntries(rulebookFields.map(key=>[key,[cite(policy)]])) as RulebookProposal['evidence'],findings:[]};
  const proposed=(await json(await c.agent(`${c.path}/rulebook/proposals`,{report_version:saved.version,proposal,source_authority:{[policy.source_id]:'policy_decision'},required_capabilities:['pneu.http']}),201)).rulebook;
  return {report:saved,proposal:proposed,policy,services};
}
export async function activate(c:Enrollment,a:Awaited<ReturnType<typeof audited>>) {
  return (await json(await c.owner.call(`${c.path}/owner/rulebooks/${a.proposal.version}/activate`,{payload_hash:a.proposal.payload_hash}))).rulebook;
}
export async function provision(c:Enrollment) {
  return json(await c.agent(`${c.path}/relay`,{}, {'idempotency-key':'test-relay-provision'}),201);
}
export async function probe(c:Enrollment,rulebookHash:string) {
  await json(await c.agent(`${c.path}/relay/probe`,{}),201);
  const privateProbe=await json(await c.agent(`${c.path}/relay/probe/inbox`));
  assert.equal(privateProbe.items[0].kind,'isolated_non_business_probe');
  return json(await c.agent(`${c.path}/relay/probe/answer`,{nonce:privateProbe.items[0].nonce,rulebook_hash:rulebookHash,method:'polling',evidence:'Scripted test client polled the private HTTP inbox; actual GrokBot support remains unverified.'}));
}
export async function operational(c:Enrollment,rulebookHash:string,scopes=operationScopes) {
  await probe(c,rulebookHash);
  return json(await c.owner.call(`${c.path}/owner/connections/${c.connectionId}/authorize-operation`,{scopes,expected_epoch:0}));
}
export async function ready(f:FreshFixture) {
  const c=await onboard(f),relay=await provision(c),audit=await audited(f,c);await activate(c,audit);await operational(c,audit.proposal.payload_hash);
  return {...c,relay,audit};
}
export function mcp(f:FreshFixture,token:string) {
  let id=0;
  return (method:string,params?:unknown,headers:Record<string,string>={})=>f.client({authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'})('/mcp',{jsonrpc:'2.0',id:++id,method,...(params?{params}:{})},headers);
}
