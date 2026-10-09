// Scripted HTTP fixture proves clean-start and actual mounted SDK transport, not a live GrokBot audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadLegacyConfig } from '../src/config.js';
import { createUnifiedSystem } from '../src/system.js';
import { rulebookFields, type Source, type RulebookParams } from '../../../packages/audit/index.js';
import { ALL_SCOPES, AUDIT_SCOPES } from '../src/handoru/store.js';
import { HandoruAudits } from '../src/handoru/audits.js';

async function stop(server:Server) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
const password = 'test-only independent human passphrase';
const legacyPassword = 'test-only legacy admin passphrase';
const setupSecret = 'test-only human account setup secret';
const customer = 'test-only shared customer bearer token';

test('fresh unified HTTP onboarding provisions a stable managed relay and exchanges a fenced SDK conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoru-unified-system-'));
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as AddressInfo).port;
  await stop(reservation);
  const base = `http://127.0.0.1:${port}`;
  const config = loadLegacyConfig({ NODE_ENV: 'production', HANDLE_FRESH: 'true',
    HANDLE_OWNER_SETUP_SECRET: setupSecret, LEGACY_PUBLIC_URL: base, LEGACY_PORT: String(port),
    LEGACY_DB_PATH: join(dir, 'legacy.sqlite'), LEGACY_RELAY_DB_PATH: join(dir, 'compat-relay.sqlite'),
    LEGACY_OWNER_PASSWORD: legacyPassword, LEGACY_STAFF_PASSWORD: 'test-only staff passphrase',
    LEGACY_CUSTOMER_A_PASSWORD: 'test-only customer A passphrase', LEGACY_CUSTOMER_B_PASSWORD: 'test-only customer B passphrase',
    LEGACY_CUSTOMER_AGENT_A_TOKEN: customer, LEGACY_CUSTOMER_AGENT_B_TOKEN: 'test-only other customer bearer token',
    LEGACY_RELAY_ADMIN_TOKEN: 'test-only relay admin bearer token', LEGACY_RELAY_REPLY_WAIT_MS: '100', LEGACY_RECONCILIATION_MS: '60000',
  });
  assert.ok(!config.env.LEGACY_BUSINESS_AGENT_TOKEN, 'No business credential supplied at clean start');
  let system = await createUnifiedSystem(config);
  let server = system.app.listen(port, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const api = '/api/handle/v1';
  const call = async (path:string, body?:unknown, headers:Record<string,string>={}) => {
    const response = await fetch(`${base}${path}`, { method:body===undefined?'GET':'POST',
      headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body) });
    const data = await response.json();
    return {status:response.status,data,headers:response.headers};
  };
  const must = async (path:string,body?:unknown,headers:Record<string,string>={}) => {
    const result = await call(path,body,headers);
    assert.ok(result.status>=200&&result.status<300, `${path}: ${result.status} ${JSON.stringify(result.data?.error??'')} ${result.data?.message??''}`);
    return result;
  };
  const bearer = (token:string) => ({authorization:`Bearer ${token}`});
  try {
    assert.ok(system.store.listOrders().length > 0);
    for(const table of ['handoru_businesses','handoru_owners','handoru_connections','handoru_credentials','handoru_relays']) {
      assert.equal((system.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0,table);
    }
    assert.notEqual((await fetch(`${base}/.well-known/agent-card.json`)).status,200);
    const manifest = (await must('/.well-known/handle.json')).data;
    assert.equal(manifest.api_base,`${base}${api}`);
    assert.equal((await fetch(`${base}/cli/handle.mjs`)).status,200);
    const registration = (await must(`${api}/agent-registrations`, {runtime:'scripted integration fixture',legacy_url:base})).data;
    assert.equal((await call(`${api}/onboarding/${registration.request_id}/credentials`,{},bearer(registration.provisional_credential))).status,409);
    const legacyLogin=await must('/api/login',{username:'owner',password:legacyPassword});
    const legacyCookie=legacyLogin.headers.get('set-cookie')!.split(';')[0];
    const legacyHeaders={cookie:legacyCookie,'x-csrf-token':legacyLogin.data.csrf_token};
    assert.equal((await call(`${api}/owner/onboarding/${registration.request_id}/decide`,{
      user_code:registration.user_code,decision:'approved',scopes:AUDIT_SCOPES},legacyHeaders)).status,401,
      'The bot-held legacy admin cookie is not an independent Handle human');
    await must('/api/admin/handle-ownership-proof',{challenge:registration.ownership_challenge.challenge},legacyHeaders);
    const human=await must(`${api}/owner/signup`,{email:'owner@example.test',password,setup_secret:setupSecret});
    const humanHeaders={cookie:human.headers.get('set-cookie')!.split(';')[0],'x-csrf-token':human.data.csrf_token};
    const consent=(await must(`${api}/owner/onboarding/${registration.request_id}/decide`,{
      user_code:registration.user_code,decision:'approved',scopes:AUDIT_SCOPES},humanHeaders)).data;
    const credentials=(await must(`${api}/onboarding/${registration.request_id}/credentials`,{},bearer(registration.provisional_credential))).data;
    const auth=bearer(credentials.access_token), biz=`${api}/businesses/${consent.business_id}`;
    assert.equal((await must(`${api}/me`,undefined,auth)).data.state,'audit_only');
    const credentialFile=join(dir,'handoru-service.json'),garageConfig=join(dir,'agent-private','garage.json');
    writeFileSync(credentialFile,JSON.stringify({url:base,token:credentials.access_token,business_id:credentials.business_id,connection_id:credentials.connection_id}),{mode:0o600});
    const garageCli=resolve(import.meta.dirname,'../../../packages/agent-client/dist/garage.mjs');
    const invokeGarage=(args:string[])=>promisify(execFile)(process.execPath,[garageCli,...args],{env:{...process.env,GARAGE_CONFIG:garageConfig,PNEU007_TOOL_TOKEN:'',PNEU007_BUSINESS_URL:''}});
    const enrolled=await invokeGarage(['enroll','--credential-file',credentialFile,'--allow-http-localhost']);
    assert.match(enrolled.stdout,/enrolled/);assert.ok(!enrolled.stdout.includes(credentials.access_token));
    assert.equal(statSync(garageConfig).mode&0o777,0o600);
    assert.equal(JSON.parse(readFileSync(garageConfig,'utf8')).connection_id,consent.connection_id);
    const cliCatalogue=await invokeGarage(['catalog','--allow-http-localhost']);
    assert.ok(!cliCatalogue.stdout.includes(credentials.access_token));
    assert.match(cliCatalogue.stdout,/wheel_swap/);

    const relay=(await must(`${biz}/relay`,{}, {...auth,'idempotency-key':'one-stable-relay'})).data;
    const relayAgain=(await must(`${biz}/relay`,{}, {...auth,'idempotency-key':'retry-same-resource'})).data;
    assert.equal(relayAgain.id,relay.id);
    assert.equal(relay.endpoint,`${base}/relay/${relay.id}/a2a`);
    assert.equal((await fetch(`${base}/relay/${relay.id}/healthz`)).status,200);
    assert.equal((await fetch(`${base}/relay/${relay.id}/.well-known/agent-card.json`)).status,404);
    assert.equal((await call(`/relay/${relay.id}/bot/inbox`,undefined,auth)).status,403);

    // G0 happens before any audit or active rulebook; it grants no business authority.
    await must(`${biz}/relay/probe`, {phase:'onboarding'}, auth);
    const g0 = (await must(`${biz}/relay/probe/inbox`, undefined, auth)).data.items[0];
    const received = (await must(`${biz}/relay/probe/answer`, {
      nonce:g0.nonce,method:'polling',evidence:'Synthetic HTTP walkthrough: received and answered the isolated pre-audit probe.',
    }, auth)).data;
    assert.equal(received.phase, 'onboarding');
    assert.equal(received.operation_ready, false);
    assert.deepEqual(system.rulebooks.list(), []);
    assert.equal((await call(`/relay/${relay.id}/bot/inbox`,undefined,auth)).status,403);
    assert.notEqual((await fetch(`${base}/.well-known/agent-card.json`)).status,200);

    // Externally authored test report cites an actual ordinary legacy HTTP read.
    const native=(await must('/api/audit/export/internal-operations',undefined,auth)).data;
    const evidence=(await must(`${biz}/audit-evidence`,{system_id:'native_pneu',url:`${base}/api/audit/export/internal-operations`,
      locator:'GET response.content',captured_at:new Date().toISOString(),method:'api',content_type:'text/plain',
      content:native.content,redacted:true},auth)).data.evidence as Source;
    const citation={source_id:evidence.source_id,version:evidence.version,hash:evidence.hash,excerpt:evidence.content};
    const report=(await must(`${biz}/audit-reports`,{schema_version:'1.0',title:'Scripted transport test audit fixture',
      summary:'Externally authored fixture only; this is not a live GrokBot audit.',systems:[{id:'native_pneu',name:'Native Pneu legacy backend',
        url:base,purpose:'Existing orders and policies',access_methods:['api'],observed_roles:['business_agent'],fact_authority:['Legacy owns bookings; independent human reviews policy']}],
      processes:[{id:'booking',description:'Native Pneu API controls its bookings.',citations:[citation]}],findings:[],questions:[],
      supported_writes:[{action:'native.booking',system_id:'native_pneu',mode:'native_enforced',description:'Use native backend policy checks.',citations:[citation]}]},auth)).data.report;
    const params:RulebookParams={auto_discount_bps:300,owner_approval_limit_bps:1000,hard_discount_limit_bps:1000,offer_ttl_seconds:1200,deposit_minor:50000,
      allowed_services:['tyre_change','wheel_swap'],currency:'CZK',allow_extras:false,provider:'local_demo',network:'local',asset:'lovelace',supplier_allowed_actions:['catalog.read']};
    const proposed=(await must(`${biz}/rulebook/proposals`,{report_version:report.version,source_authority:{[evidence.source_id]:'policy_decision'},proposal:{
      profile:{name:'Pneu 007 scripted test fixture',summary:'Human-reviewed synthetic rule mapping for transport tests.',systems:['Native Pneu'],partners:['Fictional demo tyre supplier'],channels:['web','A2A'],citations:[citation]},
      params,evidence:Object.fromEntries(rulebookFields.map((key)=>[key,[citation]])),findings:[]}},auth)).data.rulebook;
    assert.equal((await call(`${biz}/owner/rulebooks/${proposed.version}/activate`,{payload_hash:proposed.payload_hash},auth)).status,403);
    await must(`${biz}/owner/rulebooks/${proposed.version}/activate`,{payload_hash:proposed.payload_hash},humanHeaders);
    await must(`${biz}/relay/probe`,{},auth);
    const probe=(await must(`${biz}/relay/probe/inbox`,undefined,auth)).data.items[0];
    await must(`${biz}/relay/probe/answer`,{nonce:probe.nonce,rulebook_hash:proposed.payload_hash,method:'polling',evidence:'This scripted HTTP fixture successfully read and answered the private nonce; real runtime is unverified.'},auth);
    await must(`${biz}/owner/connections/${consent.connection_id}/authorize-operation`,{expected_epoch:0,scopes:ALL_SCOPES},humanHeaders);
    const card=(await must(`/relay/${relay.id}/.well-known/agent-card.json`)).data;
    assert.equal(card.supportedInterfaces[0].url,relay.endpoint);
    assert.equal(card.capabilities.pushNotifications,false);
    const customerHeaders={...bearer(customer),'A2A-Version':'1.0'};
    const sent=(await must(`/relay/${relay.id}/a2a`,{jsonrpc:'2.0',id:'send',method:'SendMessage',params:{
      message:{messageId:'fresh-unified-customer-message',role:'ROLE_USER',parts:[{text:'Test customer request'}]},configuration:{returnImmediately:true}}},customerHeaders)).data;
    const taskId=sent.result.task.id;
    let item:any;
    for(let attempt=0;attempt<30&&!item;attempt++) {
      item=(await must(`/relay/${relay.id}/bot/inbox`,undefined,auth)).data.items[0];
      if(!item)await new Promise((r)=>setTimeout(r,20));
    }
    assert.equal(item.task_id,taskId);
    assert.ok(item.lease_token);
    assert.equal((await call(`/relay/${relay.id}/bot/reply`,{work_item_id:item.work_item_id,text:'missing lease'},auth)).status,409);
    await must(`/relay/${relay.id}/bot/reply`,{work_item_id:item.work_item_id,text:'Managed relay fixture reply',state:'completed',
      lease_token:item.lease_token,claim_generation:item.claim_generation},auth);
    const got=(await must(`/relay/${relay.id}/a2a`,{jsonrpc:'2.0',id:'get',method:'GetTask',params:{id:taskId}},customerHeaders)).data;
    assert.match(JSON.stringify(got),/Managed relay fixture reply/);
    assert.equal((await call('/bot/tasks/'+taskId,undefined,auth)).status,404,'Managed task is absent from compatibility resource');
    // A second firm is an explicit synthetic isolation fixture; the first firm's onboarding above is entirely HTTP.
    const secondBusiness='transport-isolation-fixture',secondConnection='transport-isolation-connection',secondPrincipal='transport-isolation-agent';
    const humanOwner=human.data.owner;
    system.store.db.transaction(()=>{
      system.store.db.prepare('INSERT INTO handoru_businesses VALUES(?,?,?,?,?)').run(secondBusiness,'https://second-fictional.example','Second fictional test firm',secondConnection,1);
      system.store.db.prepare('INSERT INTO handoru_memberships VALUES(?,?)').run(humanOwner.id,secondBusiness);
      system.store.db.prepare('INSERT INTO handoru_principals VALUES(?,?)').run(secondPrincipal,'scripted isolation fixture');
      system.store.db.prepare('INSERT INTO handoru_connections VALUES(?,?,?,?,?,?,?)').run(secondConnection,secondBusiness,secondPrincipal,'scripted isolation fixture','active',JSON.stringify(ALL_SCOPES),null);
    })();
    const secondToken=system.handoru.issue(secondConnection),secondAuth=bearer(secondToken);
    const secondActor=system.handoru.identify(secondToken)!;
    const secondAudits=new HandoruAudits(system.store.db,secondBusiness,{authorize:(a,action)=>{
      if(action==='approve'){assert.equal(a.id,humanOwner.id);system.handoru.member(humanOwner,secondBusiness);}
      else system.handoru.authorize(a,secondBusiness,action==='write'?'audit.propose':'audit.read');
    }});
    const evidenceB=secondAudits.archiveEvidence(secondActor,{system_id:'fixture',url:'https://second-fictional.example/admin',locator:'Explicit test-fixture record',
      captured_at:new Date().toISOString(),method:'api',content_type:'text/plain',content:native.content,redacted:true});
    const citeB={source_id:evidenceB.source_id,version:evidenceB.version,hash:evidenceB.hash,excerpt:evidenceB.content};
    const reportB=secondAudits.createReport(secondActor,{schema_version:'1.0',title:'Synthetic second-firm isolation fixture',summary:'Transport isolation fixture only.',
      systems:[{id:'fixture',name:'Second fixture',url:'https://second-fictional.example',purpose:'Test isolation',access_methods:['api'],observed_roles:['service'],fact_authority:['Synthetic fixture only']}],
      processes:[],findings:[],questions:[],supported_writes:[]});
    const rulesB=secondAudits.proposeRulebook(secondActor,{report_version:reportB.version,source_authority:{[evidenceB.source_id]:'policy_decision'},proposal:{
      profile:{name:'Second synthetic firm',summary:'Synthetic isolation fixture.',systems:['fixture'],partners:['fictional'],channels:['A2A'],citations:[citeB]},params,
      evidence:Object.fromEntries(rulebookFields.map(key=>[key,[citeB]])) as Record<keyof RulebookParams,typeof citeB[]>,findings:[]}});
    secondAudits.activateRulebook({id:humanOwner.id,role:'owner'},{version:rulesB.version,payload_hash:rulesB.payload_hash});
    // Explicit synthetic capability receipt for the isolated second firm's transport fixture.
    system.store.db.prepare('UPDATE handoru_connections SET ready_json=? WHERE id=?').run(JSON.stringify({probe_passed:true,rulebook_hash:rulesB.payload_hash,method:'polling',evidence:'Synthetic isolation fixture'}),secondConnection);
    const secondRelay=(await must(`${api}/businesses/${secondBusiness}/relay`,{}, {...secondAuth,'idempotency-key':'second-isolation-resource'})).data;
    const rpcB=(method:string,params:unknown)=>must(`/relay/${secondRelay.id}/a2a`,{jsonrpc:'2.0',id:'second-firm',method,params},customerHeaders);
    const crossRead=(await rpcB('GetTask',{id:taskId})).data;
    assert.ok(crossRead.error,'Same customer cannot read A task through B resource');
    const listB=(await rpcB('ListTasks',{})).data;
    assert.deepEqual(listB.result.tasks??[],[]);
    const sentB=(await rpcB('SendMessage',{message:{messageId:'second-firm-customer-message',role:'ROLE_USER',parts:[{text:'Second isolated request'}]},configuration:{returnImmediately:true}})).data;
    const taskB=sentB.result.task.id;
    const crossCancel=(await must(`/relay/${relay.id}/a2a`,{jsonrpc:'2.0',id:'wrong-cancel',method:'CancelTask',params:{id:taskB}},customerHeaders)).data;
    assert.ok(crossCancel.error,'Same customer cannot cancel B task through A resource');
    assert.equal((await call(`/relay/${secondRelay.id}/bot/tasks/${taskId}`,undefined,secondAuth)).status,404);
    assert.equal((await call(`/relay/${secondRelay.id}/bot/inbox`,undefined,auth)).status,401,'A service token cannot claim B work');
    const cancelledB=(await rpcB('CancelTask',{id:taskB})).data;
    assert.ok(!cancelledB.error);
    await stop(server); await system.close();
    system=await createUnifiedSystem(config);server=system.app.listen(port,'127.0.0.1');
    await new Promise<void>((r)=>server.once('listening',r));
    assert.equal((await must(`${biz}/relay`,undefined,auth)).data.id,relay.id);
    const restored=(await must(`/relay/${relay.id}/a2a`,{jsonrpc:'2.0',id:'restored',method:'GetTask',params:{id:taskId}},customerHeaders)).data;
    assert.match(JSON.stringify(restored),/Managed relay fixture reply/);
    const fullContext=(await must(`${biz}/context`,undefined,auth)).data;
    assert.equal(fullContext.credentials_included,false);
    assert.ok(!JSON.stringify(fullContext).includes(credentials.access_token));
  } finally { await stop(server);await system.close();rmSync(dir,{recursive:true,force:true}); }
});
