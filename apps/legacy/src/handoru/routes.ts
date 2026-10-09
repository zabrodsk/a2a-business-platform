import express, { type Request, type NextFunction, type Response } from 'express';
import { createHmac, scryptSync } from 'node:crypto';
import type { Actor } from '../../../../packages/contracts/index.js';
import { repoRoot } from '../config.js';
import type { AgentPolicy } from '../agent-policy.js';
import { RulebookManager, SourceRegistry } from '../../../../packages/audit/index.js';
import { HandoruAudits } from './audits.js';
import { HandoruStore, AUDIT_SCOPES, ALL_SCOPES, hash, secret, id, fail, text, type Owner, type HumanSession, type Onboarding } from './store.js';
import { provisionRelay, authorizeOperation } from './onboarding.js';
import { assertCapabilities } from './capabilities.js';
import { prepareHandover, commitHandover } from './handover.js';
import { agentEntryPoints } from '../../../relay/src/agent-guide.js';

declare module 'express-serve-static-core' { interface Request { handoruHuman?:HumanSession } }
const bearer=(req:Request)=>/^Bearer (.+)$/.exec(req.header('authorization')??'')?.[1]??'';
const param=(req:Request,key:string)=>text(req.params[key],key);
export function handoruRoutes(h:HandoruStore,rulebooks:RulebookManager,policy:AgentPolicy,env:NodeJS.ProcessEnv) {
  const r=express.Router();
  const human=(req:Request,_res:Response,next:NextFunction)=>{
    try{
      if(req.header('authorization'))fail('HUMAN_REQUIRED','A separate Handle human session is required.',403);
      const s=h.identifyHuman(req.header('cookie'));if(!s)fail('HUMAN_REQUIRED','Sign in with your separate Handle owner account.',401);
      if(!['GET','HEAD'].includes(req.method)&&hash(req.header('x-csrf-token')??'')!==hash(s.csrf))fail('CSRF_REQUIRED','Invalid Handle CSRF token.',403);
      req.handoruHuman=s;next();
    }catch(error){next(error);}
  };
  const ownerActor=(req:Request):Actor=>({id:req.handoruHuman!.owner.id,role:'owner'});
  const audits=(businessId:string,owner?:Owner)=>new HandoruAudits(h.db,businessId,{now:h.now,authorize:(actor,action)=>{
    if(owner){if(actor.id!==owner.id||actor.role!=='owner')fail('HUMAN_REQUIRED','Owner authentication required.',403);h.member(owner,businessId);}
    else h.authorize(actor,businessId,action==='write'?'audit.propose':'audit.read');
  }});
  const businessRules=(businessId:string)=>new RulebookManager(h.db,new SourceRegistry(rulebooks.sources.rootDir,rulebooks.sources.webSources,rulebooks.sources.includeFixtures),{businessId,genericEvidence:businessId!=='pneu007'});
  const activeHash=(businessId:string)=>businessRules(businessId).getActive().payload_hash;
  const connection=(req:Request,scope:string,active=false)=>{
    const a=req.legacyActor;if(!a)fail('UNAUTHENTICATED','A scoped service credential is required.',401);
    const c=h.authorize(a,param(req,'businessId'),scope,active);if(active){const activeRule=businessRules(a.business_id!).getActive();assertCapabilities(activeRule.governance?.required_capabilities??[],Boolean(h.db.prepare("SELECT 1 FROM handoru_meta WHERE key=?").get(`mcp_verified:${c.id}`)));}return a;
  };
  const setSession=(res:Response,owner:Owner)=>{
    const session=h.session(owner);res.cookie('handoru_session',session.token,{httpOnly:true,secure:new URL(h.publicUrl).protocol==='https:',sameSite:'strict',path:'/',maxAge:12*60*60_000});
    return {owner:session.owner,csrf_token:session.csrf};
  };
  r.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(req.header('origin')&&req.header('origin')!==new URL(h.publicUrl).origin)return next(new Error('Foreign origin'));
    next();
  });
  r.get('/owner/session',(req,res)=>{const s=h.identifyHuman(req.header('cookie'));res.json({owner:s?.owner??null,csrf_token:s?.csrf??null,setup_required:!h.db.prepare('SELECT 1 FROM handoru_owners LIMIT 1').get()});});
  r.post('/owner/signup',(req,res)=>{h.rate(`signup:${req.ip}`,10,900_000);res.status(201).json(setSession(res,h.signup(req.body?.email,req.body?.password,req.body?.setup_secret,env.HANDORU_OWNER_SETUP_SECRET)));});
  r.post('/owner/login',(req,res)=>{h.rate(`login:${req.ip}`,20,900_000);res.json(setSession(res,h.login(req.body?.email,req.body?.password)));});
  r.post('/owner/logout',human,(req,res)=>{h.db.prepare('DELETE FROM handoru_sessions WHERE token_hash=?').run(req.handoruHuman!.hash);res.clearCookie('handoru_session',{path:'/'});res.json({ok:true});});
  r.post('/agent-registrations',(req,res)=>{h.rate(`registration:${req.ip}`,20,900_000);res.status(201).json(h.register(req.body));});
  r.get('/onboarding/:requestId',(req,res)=>{const row=h.onboarding(param(req,'requestId'),bearer(req));res.json({request_id:row.id,state:row.state,connection_id:row.connection_id,expires_at:new Date(row.expires_at).toISOString(),ownership_verification:h.ownershipVerification(row)});});
  r.post('/onboarding/:requestId/credentials',(req,res)=>{h.rate(`exchange:${req.ip}`,30);res.json(h.exchange(param(req,'requestId'),bearer(req)));});
  r.get('/owner/onboarding/:requestId',human,(req,res)=>{
    const row=h.db.prepare('SELECT o.*,p.runtime FROM handoru_onboarding o JOIN handoru_principals p ON p.id=o.principal_id WHERE o.id=?').get(param(req,'requestId')) as Onboarding&{runtime:string}|undefined;
    if(!row)fail('NOT_FOUND','Unknown onboarding.',404);res.json(ownerRequest(row,req.handoruHuman!.owner));
  });
  r.get('/owner/onboarding/:requestId/ownership-challenge',human,(req,res)=>{
    const row=h.db.prepare('SELECT * FROM handoru_onboarding WHERE id=?').get(param(req,'requestId')) as Onboarding|undefined;
    if(!row||row.state!=='pending'||row.expires_at<=h.time()||row.failures>=5)fail('ONBOARDING_UNAVAILABLE','Request expired or already decided.',409);
    const ownership_verification=h.ownershipVerification(row,req.handoruHuman!.owner);
    res.json({request_id:row.id,ownership_verification,...(ownership_verification.state==='required'?{legacy_url:row.legacy_url,challenge:row.challenge,publication_api:'/api/admin/handle-ownership-proof',public_path:'/.well-known/handle-ownership.json'}:{})});
  });
  r.post('/owner/onboarding/:requestId/decide',human,(req,res)=>res.json(h.decide(req.handoruHuman!.owner,param(req,'requestId'),req.body?.user_code,req.body?.decision,req.body?.scopes)));
  r.get('/me',(req,res)=>{const a=req.legacyActor;if(!a?.connection_id)fail('UNAUTHENTICATED','Business connection required.',401);h.authorize(a,a.business_id!,'audit.read');const c=h.connection(a.connection_id);res.json({role:'business_agent',principal_id:a.id,connection_id:c.id,business_id:c.business_id,state:c.state,scopes:JSON.parse(c.scopes_json),execution_epoch:h.business(c.business_id).execution_epoch});});
  r.get('/owner/dashboard',human,(req,res)=>{
    const owner=req.handoruHuman!.owner;
    const businesses=(h.db.prepare('SELECT b.* FROM handoru_businesses b JOIN handoru_memberships m ON m.business_id=b.id WHERE m.owner_id=?').all(owner.id) as {id:string}[]).map(b=>{
      const a=audits(b.id,owner),context=a.context(ownerActor(req));
      return {...b,connections:(h.db.prepare('SELECT * FROM handoru_connections WHERE business_id=?').all(b.id) as {scopes_json:string;ready_json:string|null}[]).map(({scopes_json,ready_json,...c})=>({...c,scopes:JSON.parse(scopes_json),readiness:ready_json?JSON.parse(ready_json):null})),relay:h.db.prepare('SELECT id,endpoint,inbox,probe_passed FROM handoru_relays WHERE business_id=?').get(b.id)??null,publications:h.db.prepare('SELECT id,state,verified_at,rulebook_hash FROM handoru_publications WHERE business_id=?').all(b.id),handoffs:(h.db.prepare('SELECT * FROM handoru_handoffs WHERE business_id=?').all(b.id) as {external_json:string}[]).map(({external_json,...v})=>({...v,external_access:JSON.parse(external_json)})),...context,cases:(h.db.prepare('SELECT payload_json FROM agent_cases').all() as {payload_json:string}[]).map(v=>JSON.parse(v.payload_json)).filter(c=>(c.business_id??'pneu007')===b.id).map(c=>({...c,quote:c.quote_id?policy.store.getQuote(c.quote_id):null,order:c.order_id?policy.store.getOrder(c.order_id):null,payment:c.order_id?policy.store.listPaymentIntents().filter(i=>i.order_id===c.order_id).map(i=>({intent_id:i.intent_id,state:i.state,provider:i.provider,order_id:i.order_id,input_hash:i.input_hash,identifier_from_purchaser:i.identifier_from_purchaser,provider_payment_id:i.observation?.provider_payment_id})):[]})),operations:h.db.prepare('SELECT id,kind,connection_id,execution_epoch FROM handoru_operations WHERE business_id=?').all(b.id),approvals:policy.listApprovals(ownerActor(req)).filter(a=>(policy.getCase(ownerActor(req),a.case_id).business_id??'pneu007')===b.id).map(a=>({...a,quote:policy.store.getQuote(a.quote_id)}))};
    });
    const requests=(h.db.prepare("SELECT o.*,p.runtime FROM handoru_onboarding o JOIN handoru_principals p ON p.id=o.principal_id WHERE o.expires_at>? AND o.state='pending' AND NOT EXISTS (SELECT 1 FROM handoru_businesses b JOIN handoru_memberships m ON m.business_id=b.id WHERE b.legacy_url=o.legacy_url AND NOT EXISTS (SELECT 1 FROM handoru_memberships own WHERE own.business_id=b.id AND own.owner_id=?))").all(h.time(),owner.id) as (Onboarding&{runtime:string})[]).map(row=>ownerRequest(row,owner));
    res.json({businesses,requests});
  });
  function ownerRequest(row:Onboarding&{runtime:string},owner:Owner) {
    return {id:row.id,legacy_url:row.legacy_url,state:row.state,expires_at:row.expires_at,runtime:row.runtime,ownership_verification:h.ownershipVerification(row,owner)};
  }
  const b='/businesses/:businessId';
  r.post(`${b}/connections/:connectionId/credentials/rotate`,(req,res)=>res.json(h.rotate(bearer(req),param(req,'businessId'),param(req,'connectionId'))));
  r.post(`${b}/relay`,(req,res)=>{const a=connection(req,'relay.provision');res.status(201).json(provisionRelay(h,a,a.business_id!,text(req.header('idempotency-key'),'Idempotency-Key'),env.HANDORU_RELAY_PUBLIC_URL??h.publicUrl));});
  r.get(`${b}/relay`,(req,res)=>{connection(req,'relay.provision');res.json(h.db.prepare('SELECT id,business_id,endpoint,inbox,probe_passed FROM handoru_relays WHERE business_id=?').get(param(req,'businessId'))??null);});
  type Probe = {nonce:string;created_at:number;phase?:'onboarding'|'rulebook'};
  const pendingProbe=(connectionId:string):Probe|null=>{
    const row=h.db.prepare('SELECT value FROM handoru_meta WHERE key=?').get(`probe:${connectionId}`) as {value:string}|undefined;
    return row?JSON.parse(row.value):null;
  };
  const probePhase=(probe:Probe)=>probe.phase??'rulebook';
  r.post(`${b}/relay/probe`,(req,res)=>{
    const a=connection(req,'relay.provision'),nonce=secret(),phase=req.body?.phase??'rulebook';
    if(!['onboarding','rulebook'].includes(phase))fail('INVALID_PROBE_PHASE','Use onboarding or rulebook.');
    h.db.transaction(()=>{
      if(!h.db.prepare('SELECT 1 FROM handoru_relays WHERE business_id=?').get(a.business_id!))fail('RELAY_REQUIRED','Provision relay first.',409);
      // The private G0 challenge must not change an active runtime's policy readiness.
      if(phase==='rulebook')h.db.prepare('UPDATE handoru_relays SET probe_nonce=?,probe_connection=?,probe_at=?,probe_passed=0 WHERE business_id=?').run(hash(nonce),a.connection_id!,h.time(),a.business_id!);
      h.db.prepare('INSERT INTO handoru_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`probe:${a.connection_id}`,JSON.stringify({nonce,created_at:h.time(),phase}));
    }).immediate();
    res.status(201).json({state:'pending',phase,probe_task_id:id('probe'),inbox_url:`${h.publicUrl}/api/handle/v1${b.replace(':businessId',a.business_id!)}/relay/probe/inbox`,expires_in:300});
  });
  r.get(`${b}/relay/probe/inbox`,(req,res)=>{
    const a=connection(req,'relay.provision'),probe=pendingProbe(a.connection_id!);
    if(!probe||probe.created_at+300_000<=h.time())fail('PROBE_EXPIRED','Start a new probe.',409);
    const phase=probePhase(probe);
    if(req.query.phase!==undefined&&req.query.phase!==phase)fail('PROBE_INVALID','Probe phase does not match the pending challenge.',409);
    res.json({phase,items:[{kind:'isolated_non_business_probe',phase,nonce:probe.nonce,instructions:phase==='onboarding'?'Return nonce and your actual polling/routine method. This pre-audit check grants no business operation authority. Scripted capability is not proof of a specific runtime.':'Return nonce, exact active rulebook hash, and your actual polling/routine method. Scripted capability is not proof of a specific runtime.'}]});
  });
  r.post(`${b}/relay/probe/answer`,(req,res)=>{
    const a=connection(req,'relay.provision');
    const readiness=h.db.transaction(()=>{
      const probe=pendingProbe(a.connection_id!);
      if(!probe||probe.created_at+300_000<=h.time()||hash(text(req.body?.nonce,'nonce'))!==hash(probe.nonce))fail('PROBE_INVALID','Invalid or expired probe.',409);
      const phase=probePhase(probe);
      if(req.body?.phase!==undefined&&req.body.phase!==phase)fail('PROBE_INVALID','Probe phase does not match the pending challenge.',409);
      if(phase==='rulebook'){
        const relay=h.db.prepare('SELECT * FROM handoru_relays WHERE business_id=?').get(a.business_id!) as {probe_nonce:string;probe_connection:string;probe_at:number}|undefined;
        if(!relay||relay.probe_connection!==a.connection_id||relay.probe_at+300_000<=h.time()||hash(probe.nonce)!==relay.probe_nonce)fail('PROBE_INVALID','Invalid or expired probe.',409);
        if(req.body?.rulebook_hash!==activeHash(a.business_id!))fail('RULEBOOK_HASH_MISMATCH','Acknowledge the current active rulebook.',409);
      }
      if(!['polling','routine','wake_up'].includes(req.body?.method))fail('CAPABILITY_REQUIRED','Describe actual supported polling/routine/wake-up.');
      const readiness={probe_passed:true,phase,...(phase==='onboarding'?{operation_ready:false}:{rulebook_hash:req.body.rulebook_hash}),method:req.body.method,evidence:text(req.body?.evidence,'capability evidence',4000),verified_at:h.now().toISOString(),runtime_claim:'client_reported; verify actual product separately'};
      if(phase==='onboarding'){
        h.db.prepare('INSERT INTO handoru_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`onboarding_probe:${a.connection_id}`,JSON.stringify(readiness));
      }else{
        h.db.prepare('UPDATE handoru_connections SET ready_json=? WHERE id=?').run(JSON.stringify(readiness),a.connection_id!);
        h.db.prepare('UPDATE handoru_relays SET probe_passed=1,probe_nonce=NULL WHERE business_id=?').run(a.business_id!);
      }
      h.db.prepare('DELETE FROM handoru_meta WHERE key=?').run(`probe:${a.connection_id}`);
      return readiness;
    }).immediate();
    res.json(readiness);
  });
  r.get(`${b}/capabilities`,(req,res)=>{
    const a=connection(req,'audit.read'),onboarding=h.db.prepare('SELECT value FROM handoru_meta WHERE key=?').get(`onboarding_probe:${a.connection_id}`) as {value:string}|undefined;
    res.json({business_id:a.business_id,http:{supported:true,enforcement:'native_backend',capability_ids:['pneu.http','relay.polling','website.agent_card']},mcp:{endpoint:`${h.publicUrl}/mcp`,protocol_version:'2025-06-18',transport:'streamable_http_stateless',server_implemented:true,runtime_verified:false},onboarding_readiness:onboarding?JSON.parse(onboarding.value):null,readiness:h.connection(a.connection_id!).ready_json?JSON.parse(h.connection(a.connection_id!).ready_json!):null,external_admin_enforcement:false});
  });
  r.post(`${b}/audit-evidence`,(req,res)=>{const a=connection(req,'audit.propose');res.status(201).json({evidence:audits(a.business_id!).archiveEvidence(a,req.body)});});
  r.get(`${b}/audit-evidence/:sourceId`,(req,res)=>{const a=connection(req,'audit.read');res.json({evidence:audits(a.business_id!).getEvidence(a,param(req,'sourceId'))});});
  r.post(`${b}/audit-reports`,(req,res)=>{const a=connection(req,'audit.propose');res.status(201).json({report:audits(a.business_id!).createReport(a,req.body)});});
  r.get(`${b}/audit-reports/:version`,(req,res)=>{const a=connection(req,'audit.read');res.json({report:audits(a.business_id!).getReport(a,Number(param(req,'version')))});});
  r.post(`${b}/source-checks`,(req,res)=>{const a=connection(req,'audit.propose');res.json({check:audits(a.business_id!).recordFreshness(a,req.body)});});
  r.post(`${b}/rulebook/proposals`,(req,res)=>{const a=connection(req,'audit.propose');res.status(201).json({rulebook:audits(a.business_id!).proposeRulebook(a,req.body)});});
  r.post(`${b}/owner/rulebooks/:version/activate`,human,(req,res)=>{
    const businessId=param(req,'businessId');
    if(h.db.prepare("SELECT 1 FROM payment_intents i JOIN agent_cases c ON c.order_id=i.order_id WHERE json_extract(i.request_json,'$.authorization.kind')='agent_mandate' AND i.state NOT IN ('failed','refunded','seller_paid') AND COALESCE(json_extract(c.payload_json,'$.business_id'),'pneu007')=? LIMIT 1").get(businessId))fail('AGENT_PAYMENT_PENDING','Cannot replace rules during accepted payment.',409);
    h.member(req.handoruHuman!.owner,businessId);const active=businessRules(businessId).activate(ownerActor(req),Number(param(req,'version')),req.body?.payload_hash);h.event(businessId,'rulebook.activated',ownerActor(req).id,{version:active.version,payload_hash:active.payload_hash});res.json({rulebook:active});
  });
  r.post(`${b}/owner/questions/:version/:questionId/answer`,human,(req,res)=>res.json({answer:audits(param(req,'businessId'),req.handoruHuman!.owner).answerQuestion(ownerActor(req),{...req.body,report_version:Number(param(req,'version')),question_id:param(req,'questionId')})}));
  r.post(`${b}/owner/connections/:connectionId/authorize-operation`,human,(req,res)=>{const businessId=param(req,'businessId');h.member(req.handoruHuman!.owner,businessId);activeHash(businessId);assertCapabilities(businessRules(businessId).getActive().governance?.required_capabilities??[],Boolean(h.db.prepare('SELECT 1 FROM handoru_meta WHERE key=?').get(`mcp_verified:${param(req,'connectionId')}`)));res.json(authorizeOperation(h,req.handoruHuman!.owner,param(req,'businessId'),param(req,'connectionId'),req.body,activeHash(param(req,'businessId'))));});
  r.post(`${b}/owner/connections/:connectionId/revoke`,human,(req,res)=>{h.revoke(req.handoruHuman!.owner,param(req,'businessId'),param(req,'connectionId'));res.json({ok:true,external_access_revocation_pending:true});});
  r.post(`${b}/owner/legacy-access/revoke`,human,(req,res)=>{
    const businessId=param(req,'businessId');h.member(req.handoruHuman!.owner,businessId);
    if(h.installation()?.id!==businessId)fail('FORBIDDEN','Only the bound native installation can rotate legacy accounts.',403);
    const username=text(req.body?.username,'legacy username');
    const user=h.db.prepare('SELECT actor_json FROM legacy_users WHERE username=?').get(username) as {actor_json:string}|undefined;
    if(!user||!['owner','staff'].includes(JSON.parse(user.actor_json).role))fail('ACCOUNT_UNAVAILABLE','Select the native audit owner/staff account.',404);
    const password=secret(),salt=secret(),actorId=JSON.parse(user.actor_json).id;
    h.db.transaction(()=>{
      h.db.prepare('UPDATE legacy_users SET password_hash=?,salt=? WHERE username=?').run(scryptSync(password,salt,64).toString('hex'),salt,username);
      h.db.prepare('INSERT INTO legacy_credential_rotations VALUES(?,?) ON CONFLICT(username) DO UPDATE SET rotated_at=excluded.rotated_at').run(username,h.now().toISOString());
      h.db.prepare("DELETE FROM legacy_sessions WHERE json_extract(actor_json,'$.id')=?").run(actorId);
      h.event(businessId,'native_admin_access.rotated',req.handoruHuman!.owner.id,{username,sessions_revoked:true});
    }).immediate();
    res.json({username,replacement_password:password,state:'verified_revoked',evidence:'Native password rotated persistently and all prior browser sessions invalidated. Deliver the replacement only to the human owner; do not give it to the departing bot.'});
  });
  r.post(`${b}/owner/approvals/:approvalId/decide`,human,(req,res)=>{h.bindNativeOwner(req.handoruHuman!.owner,param(req,'businessId'));const approval=policy.listApprovals(ownerActor(req)).find(a=>a.id===param(req,'approvalId'));if(!approval||(policy.getCase(ownerActor(req),approval.case_id).business_id??'pneu007')!==param(req,'businessId'))fail('FORBIDDEN','Approval belongs to another business.',403);res.json({approval:policy.decideApproval(ownerActor(req),param(req,'approvalId'),req.body?.decision)});});
  r.post(`${b}/owner/handoffs`,human,(req,res)=>{
    const businessId=param(req,'businessId'),owner=req.handoruHuman!.owner;
    if(req.body?.rulebook_hash!==activeHash(businessId))fail('RULEBOOK_HASH_MISMATCH','Review current rulebook.',409);
    const reportVersion=businessRules(businessId).getActive().governance?.report_version;
    const report=reportVersion?audits(businessId,owner).getReport(ownerActor(req),reportVersion):null;
    if(!report&&businessId!=='pneu007')fail('APPROVED_INVENTORY_REQUIRED','Handover requires the active rulebook inventory.',409);
    const systems=report?.systems.filter(s=>s.observed_roles.some(role=>!['public','anonymous','service_account'].includes(role))).map(s=>s.id)??[];
    res.status(201).json(prepareHandover(h,owner,businessId,req.body,systems));
  });
  r.post(`${b}/owner/handoffs/:handoffId/commit`,human,(req,res)=>res.json(commitHandover(h,req.handoruHuman!.owner,param(req,'businessId'),param(req,'handoffId'),activeHash(param(req,'businessId')))));
  const cursorSecret=()=>{
    let row=h.db.prepare("SELECT value FROM handoru_meta WHERE key='cursor_secret'").get() as {value:string}|undefined;
    if(!row){h.db.prepare("INSERT INTO handoru_meta VALUES('cursor_secret',?)").run(secret());row=h.db.prepare("SELECT value FROM handoru_meta WHERE key='cursor_secret'").get() as {value:string};}return row.value;
  };
  const cursor=(businessId:string,after:number)=>{const data=Buffer.from(JSON.stringify({businessId,after})).toString('base64url');return `${data}.${createHmac('sha256',cursorSecret()).update(data).digest('hex')}`;};
  const readCursor=(businessId:string,value:unknown)=>{
    if(value===undefined)return 0;
    try{const [data,signature]=text(value,'cursor',2048).split('.');if(hash(createHmac('sha256',cursorSecret()).update(data).digest('hex'))!==hash(signature))throw Error();const decoded=JSON.parse(Buffer.from(data,'base64url').toString());if(decoded.businessId!==businessId||!Number.isSafeInteger(decoded.after)||decoded.after<0)throw Error();return decoded.after as number;}catch{fail('INVALID_CURSOR','Cursor is unavailable for this business.');}
  };
  r.get(`${b}/context`,(req,res)=>{
    const a=connection(req,'context.read'),context=audits(a.business_id!).context(a);
    const watermark=(h.db.prepare('SELECT COALESCE(MAX(id),0) n FROM handoru_events WHERE business_id=?').get(a.business_id!) as {n:number}).n;
    const cases=(h.db.prepare('SELECT payload_json FROM agent_cases').all() as {payload_json:string}[]).map(v=>JSON.parse(v.payload_json)).filter(c=>(c.business_id??'pneu007')===a.business_id).map(c=>{const row=h.db.prepare('SELECT payload_json FROM agent_approvals WHERE case_id=? AND quote_id=?').get(c.id,c.quote_id??'') as {payload_json:string}|undefined;return {...c,quote:c.quote_id?policy.store.getQuote(c.quote_id):null,approval:row?JSON.parse(row.payload_json):null};});
    const operations=(h.db.prepare('SELECT id,kind,operation_key,result_json FROM handoru_operations WHERE business_id=?').all(a.business_id!) as {result_json:string}[]).map(({result_json,...v})=>({...v,result:JSON.parse(result_json)}));
    const snapshot={...context,cases,operations,watermarks:{audit_version:context.cursor,event:watermark},credentials_included:false,live_source_freshness:'verify critical facts separately'};
    res.json({...snapshot,snapshot_hash:hash(JSON.stringify(snapshot)),cursor:cursor(a.business_id!,watermark)});
  });
  r.get(`${b}/events`,(req,res)=>{const a=connection(req,'context.read'),after=readCursor(a.business_id!,req.query.after);const events=h.db.prepare('SELECT id,kind,actor_id,payload_json,created_at FROM handoru_events WHERE business_id=? AND id>? ORDER BY id LIMIT 100').all(a.business_id!,after) as {id:number;payload_json:string}[];res.json({events:events.map(({payload_json,...v})=>({...v,payload:JSON.parse(payload_json)})),cursor:cursor(a.business_id!,events.at(-1)?.id??after)});});
  r.get(`${b}/operations/:operationId`,(req,res)=>{const a=connection(req,'context.read'),row=h.db.prepare('SELECT id,kind,result_json FROM handoru_operations WHERE business_id=? AND id=?').get(a.business_id!,param(req,'operationId')) as {id:string;kind:string;result_json:string}|undefined;if(!row)fail('NOT_FOUND','Unknown operation.',404);res.json({id:row.id,kind:row.kind,result:JSON.parse(row.result_json)});});
  r.post(`${b}/website-publications`,(req,res)=>{
    const a=connection(req,'website.agent-card.publish',true),rulebookHash=activeHash(a.business_id!),descriptor=agentCardDescriptor(h,a.business_id!,rulebookHash,businessRules(a.business_id!).getActive().params.allowed_services,env.DEMO_PUBLIC_A2A==='true'&&a.business_id==='pneu007',env.DEMO_CHAT_APPROVAL==='true'&&a.business_id==='pneu007',env.DEMO_OPEN_BUSINESS==='true'&&a.business_id==='pneu007'&&!h.isManagedContext());const key=text(req.header('idempotency-key'),'Idempotency-Key');
    h.db.prepare('INSERT INTO handoru_publications(id,business_id,operation_key,descriptor_json,state,rulebook_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(business_id,operation_key) DO NOTHING').run(id('publication'),a.business_id!,key,JSON.stringify(descriptor),'prepared',rulebookHash);
    const p=h.db.prepare('SELECT id,state,descriptor_json,rulebook_hash FROM handoru_publications WHERE business_id=? AND operation_key=?').get(a.business_id!,key) as {rulebook_hash:string};if(p.rulebook_hash!==rulebookHash)fail('IDEMPOTENCY_CONFLICT','Publication key belongs to an older rulebook.',409);res.status(201).json(p);
  });
  r.get(`${b}/website-publications/:publicationId`,(req,res)=>{const a=connection(req,'website.agent-card.publish',true);const row=h.db.prepare('SELECT id,state,descriptor_json,verified_at FROM handoru_publications WHERE business_id=? AND id=?').get(a.business_id!,param(req,'publicationId'));if(!row)fail('NOT_FOUND','Unknown publication.',404);res.json(row);});
  r.post(`${b}/website-publications/:publicationId/verify`,async(req,res)=>{
    const a=connection(req,'website.agent-card.publish',true),publicationId=param(req,'publicationId');
    const publication=h.db.prepare("SELECT descriptor_json,state,rulebook_hash FROM handoru_publications WHERE id=? AND business_id=?").get(publicationId,a.business_id!) as {descriptor_json:string;state:string;rulebook_hash:string}|undefined;
    if(!publication||publication.state==='prepared')fail('PUBLICATION_NOT_WRITTEN','Write the descriptor through the native site tool first.',409);
    if(publication.rulebook_hash!==activeHash(a.business_id!))fail('PUBLICATION_STALE','Publication belongs to another reviewed rulebook.',409);
    const base=h.business(a.business_id!).legacy_url;
    const [cardResponse,homeResponse]=await Promise.all([fetch(`${base}/.well-known/agent-card.json`,{signal:AbortSignal.timeout(10_000),redirect:'error'}),fetch(base,{signal:AbortSignal.timeout(10_000),redirect:'error'})]);
    const card=await cardResponse.json(),home=await homeResponse.text();h.authorize(a,a.business_id!,'website.agent-card.publish',true);if(publication.rulebook_hash!==activeHash(a.business_id!))fail('PUBLICATION_STALE','Rulebook changed during verification.',409);
    if(!cardResponse.ok||!homeResponse.ok||hash(JSON.stringify(card))!==hash(publication.descriptor_json)||!home.includes('href="/.well-known/agent-card.json"'))fail('PUBLICATION_VERIFICATION_FAILED','Public card or direct visible link does not match.',409);
    h.db.prepare("UPDATE handoru_publications SET state='verified',verified_at=? WHERE id=?").run(h.now().toISOString(),publicationId);res.json({id:publicationId,state:'verified',verified_at:h.now().toISOString()});
  });
  return {router:r,human,audits,activeHash};
}
export function agentCardDescriptor(h:HandoruStore,businessId:string,_rulebookHash:string,services:string[]=['tyre_change','wheel_swap'],demo=false,chat=false,open=false) {
  const b=h.business(businessId),relay=h.db.prepare('SELECT endpoint FROM handoru_relays WHERE business_id=?').get(businessId) as {endpoint:string}|undefined;
  if(!relay)fail('RELAY_REQUIRED','Provision managed relay first.',409);
  return {name:'Pneu 007',description:'Fictional tyre service in Holešovice, Prague 7, for a hackathon. Sandbox only. Customers: use the A2A interface for service questions and quotes. Business owners: follow documentationUrl to onboard your business, connect tools and set up automatic wake-up.',version:'1.1.0',documentationUrl:`${h.publicUrl}/agents.md`,provider:{organization:b.name,url:b.legacy_url},supportedInterfaces:[{url:relay.endpoint,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{streaming:false,pushNotifications:false,extensions:[{uri:`${h.publicUrl}/agents.md`,description:'Customer and business-owner setup instructions',required:false,params:agentEntryPoints(h.publicUrl,demo,chat,open)}]},securitySchemes:demo?{}:{bearer:{httpAuthSecurityScheme:{scheme:'Bearer',bearerFormat:'opaque',description:`Register and link a customer agent at ${h.publicUrl}/auth.md. A signed-in customer must confirm access; booking and payment require separate customer authorization.`}}},securityRequirements:demo?[]:[{schemes:{bearer:{list:[]}}}],defaultInputModes:['text/plain','application/json'],defaultOutputModes:['text/plain','application/json'],skills:[{id:services.includes('tyre_change')?'tyre-change-booking':'wheel-swap-booking',name:services.includes('tyre_change')?'Tyre change quote & booking':'Wheel swap quote & booking',description:`Quote and book fictional services: ${services.join(', ')}.`,tags:['tyres','booking'],examples:['Change my four tyres, personal car, 18-inch alu rims, by Friday.']}]};
}
