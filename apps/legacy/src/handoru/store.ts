import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BusinessError, type Actor } from '../../../../packages/contracts/index.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const id = (kind: string) => `${kind}-${randomUUID()}`;
export const secret = () => randomBytes(32).toString('base64url');
export function fail(code: string, message: string, status = 400): never { throw new BusinessError(code, message, status); }
export function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT', `Invalid ${label}.`);
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const AUDIT_SCOPES = ['audit.read','audit.propose','questions.create','relay.provision','context.read'];
export const OPERATION_SCOPES = ['cases.quote','orders.checkout','inbox.claim','inbox.reply','registry.publish'];
export const ALL_SCOPES = [...AUDIT_SCOPES, ...OPERATION_SCOPES, 'website.agent-card.publish'];
export interface Business { id:string; legacy_url:string; name:string; active_connection_id:string|null; execution_epoch:number }
export interface Connection { id:string; business_id:string; principal_id:string; runtime:string; state:string; scopes_json:string; ready_json:string|null }
export interface Owner { id:string; email:string }
export interface HumanSession { owner:Owner; csrf:string; hash:string }
export interface Onboarding { id:string;principal_id:string;legacy_url:string;challenge:string;expires_at:number;state:string;connection_id:string|null;code_hash:string;failures:number }

/** Firm-owned state; credentials are always stored as one-way hashes. */
export class HandoruStore {
  validateActive?: (actor:Actor,business:Business,connection:Connection,scope:string)=>void;
  constructor(readonly db: Database.Database, readonly publicUrl: string, readonly now:()=>Date = ()=>new Date()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handoru_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_owners(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_sessions(token_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_businesses(id TEXT PRIMARY KEY,legacy_url TEXT UNIQUE NOT NULL,name TEXT NOT NULL,active_connection_id TEXT,execution_epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS handoru_memberships(owner_id TEXT NOT NULL,business_id TEXT NOT NULL,PRIMARY KEY(owner_id,business_id));
      CREATE TABLE IF NOT EXISTS handoru_principals(id TEXT PRIMARY KEY,runtime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_onboarding(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,legacy_url TEXT NOT NULL,provisional_hash TEXT UNIQUE NOT NULL,code_hash TEXT NOT NULL,challenge TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',connection_id TEXT,failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS handoru_connections(id TEXT PRIMARY KEY,business_id TEXT NOT NULL,principal_id TEXT NOT NULL,runtime TEXT NOT NULL,state TEXT NOT NULL,scopes_json TEXT NOT NULL,ready_json TEXT);
      CREATE TABLE IF NOT EXISTS handoru_credentials(token_hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_relays(id TEXT PRIMARY KEY,business_id TEXT UNIQUE NOT NULL,endpoint TEXT NOT NULL,inbox TEXT NOT NULL,probe_nonce TEXT,probe_connection TEXT,probe_at INTEGER,probe_passed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS handoru_operations(id TEXT PRIMARY KEY,business_id TEXT NOT NULL,operation_key TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,connection_id TEXT,execution_epoch INTEGER,result_json TEXT NOT NULL,UNIQUE(business_id,kind,operation_key));
      CREATE TABLE IF NOT EXISTS handoru_events(id INTEGER PRIMARY KEY AUTOINCREMENT,business_id TEXT NOT NULL,kind TEXT NOT NULL,actor_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_handoffs(id TEXT PRIMARY KEY,business_id TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,expected_epoch INTEGER NOT NULL,rulebook_hash TEXT NOT NULL,state TEXT NOT NULL,external_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoru_publications(id TEXT PRIMARY KEY,business_id TEXT NOT NULL,operation_key TEXT NOT NULL,descriptor_json TEXT NOT NULL,state TEXT NOT NULL,verified_at TEXT,UNIQUE(business_id,operation_key));
      CREATE TABLE IF NOT EXISTS handoru_reply_outbox(work_item_id TEXT PRIMARY KEY,business_id TEXT NOT NULL,record_json TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS handoru_rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
    `);
    const publicationColumns=db.prepare('PRAGMA table_info(handoru_publications)').all() as {name:string}[];
    if(!publicationColumns.some(c=>c.name==='rulebook_hash'))db.exec("ALTER TABLE handoru_publications ADD COLUMN rulebook_hash TEXT");
  }
  time() { return this.now().getTime(); }
  rate(key:string, maximum=30, duration=60_000) {
    const now=this.time(); this.db.prepare('DELETE FROM handoru_rate_limits WHERE reset_at<=?').run(now);
    const row=this.db.prepare('SELECT count FROM handoru_rate_limits WHERE key=?').get(key) as {count:number}|undefined;
    if (row && row.count>=maximum) fail('RATE_LIMIT','Too many requests.',429);
    this.db.prepare('INSERT INTO handoru_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+duration);
  }
  business(businessId:string):Business {
    const row=this.db.prepare('SELECT * FROM handoru_businesses WHERE id=?').get(businessId) as Business|undefined;
    return row??fail('BUSINESS_NOT_FOUND','Unknown business.',404);
  }
  installation():Business|undefined { return this.db.prepare('SELECT b.* FROM handoru_businesses b JOIN handoru_meta m ON m.key=\'installation_business\' AND m.value=b.id').get() as Business|undefined; }
  connection(connectionId:string):Connection {
    const row=this.db.prepare('SELECT * FROM handoru_connections WHERE id=?').get(connectionId) as Connection|undefined;
    return row??fail('CONNECTION_NOT_FOUND','Unknown connection.',404);
  }
  event(businessId:string, kind:string, actorId:string, payload:unknown) {
    this.db.prepare('INSERT INTO handoru_events(business_id,kind,actor_id,payload_json,created_at) VALUES(?,?,?,?,?)').run(businessId,kind,actorId,JSON.stringify(payload),this.now().toISOString());
  }
  member(owner:Owner,businessId:string) {
    if (!this.db.prepare('SELECT 1 FROM handoru_memberships WHERE owner_id=? AND business_id=?').get(owner.id,businessId)) fail('FORBIDDEN','No owner membership for this business.',403);
  }
  bindNativeOwner(owner:Owner,businessId:string) {
    this.member(owner,businessId);
    if(this.installation()?.id!==businessId)fail('FORBIDDEN','Human owner is not bound to this native installation.',403);
    this.db.prepare("INSERT INTO staff(id,name,role) VALUES(?,?,'owner') ON CONFLICT(id) DO NOTHING").run(owner.id,owner.email);
  }
  register(input:{runtime:unknown;legacy_url:unknown}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['runtime','legacy_url'].includes(k)))fail('INVALID_INPUT','Supply runtime and legacy_url.');
    const runtime=text(input.runtime,'runtime');let url:URL;
    try{url=new URL(text(input.legacy_url,'legacy_url',2048));}catch{fail('INVALID_URL','Use a valid legacy website origin.');}
    if (url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)) fail('INVALID_URL','Use a website origin without credentials.');
    if (url.origin!==new URL(this.publicUrl).origin) fail('LEGACY_UNSUPPORTED','This installation can only claim its own verified legacy website.',422);
    const principal=id('agent'),request=id('onboard'),token=secret(),code=String(randomBytes(4).readUInt32BE()%1_000_000).padStart(6,'0'),challenge=secret();
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO handoru_principals VALUES(?,?)').run(principal,runtime);
      this.db.prepare('INSERT INTO handoru_onboarding(id,principal_id,legacy_url,provisional_hash,code_hash,challenge,expires_at) VALUES(?,?,?,?,?,?,?)').run(request,principal,url.origin,hash(token),hash(`${request}:${code}`),challenge,this.time()+15*60_000);
    }).immediate();
    return {request_id:request,principal_id:principal,provisional_credential:token,user_code:code,verification_url:`${this.publicUrl}/handle?request=${request}`,expires_in:900,requested_scopes:[...AUDIT_SCOPES],ownership_challenge:{path:'/.well-known/handle-ownership.json',challenge,publication_api:'/api/admin/handle-ownership-proof'}};
  }
  onboarding(requestId:string,token:string) {
    const row=this.db.prepare('SELECT * FROM handoru_onboarding WHERE id=? AND provisional_hash=?').get(requestId,hash(token)) as Onboarding|undefined;
    if (!row||row.expires_at<=this.time()||row.failures>=5) fail('ONBOARDING_UNAVAILABLE','Invalid or expired onboarding credential.',401);
    return row;
  }
  ownershipVerification(row:Onboarding,owner?:Owner) {
    let state:'required'|'verified'|'not_required'='required';
    const business=this.db.prepare('SELECT id FROM handoru_businesses WHERE legacy_url=?').get(row.legacy_url) as {id:string}|undefined;
    if(owner&&business&&this.db.prepare('SELECT 1 FROM handoru_memberships WHERE business_id=?').get(business.id)) {
      this.member(owner,business.id);
      state='not_required';
    } else {
      const proof=this.db.prepare("SELECT value FROM handoru_meta WHERE key='ownership_proof'").get() as {value:string}|undefined;
      if(proof&&JSON.parse(proof.value).challenge===row.challenge)state='verified';
    }
    return {state,ready_for_consent:state!=='required'&&row.state==='pending'&&row.expires_at>this.time()&&row.failures<5};
  }
  signup(email:unknown,password:unknown,setup:unknown,expectedSetup:string|undefined) {
    if (!expectedSetup||typeof setup!=='string'||hash(setup)!==hash(expectedSetup)) fail('OWNER_SETUP_REQUIRED','Use the separate Handle owner setup credential.',403);
    const address=text(email,'email').trim().toLowerCase(),pass=text(password,'password',200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)||pass.length<12) fail('INVALID_ACCOUNT','Use a valid email and at least 12 password characters.');
    return this.db.transaction(()=>{
      if (this.db.prepare('SELECT 1 FROM handoru_owners LIMIT 1').get()) fail('OWNER_EXISTS','First owner already exists. Sign in.',409);
      const owner:Owner={id:id('human'),email:address},salt=secret();
      this.db.prepare('INSERT INTO handoru_owners VALUES(?,?,?,?)').run(owner.id,owner.email,salt,scryptSync(pass,salt,64).toString('hex'));
      return owner;
    }).immediate();
  }
  login(email:unknown,password:unknown) {
    const row=this.db.prepare('SELECT * FROM handoru_owners WHERE email=?').get(text(email,'email').trim().toLowerCase()) as Owner&{salt:string;password_hash:string}|undefined;
    const calculated=scryptSync(text(password,'password',200),row?.salt??'absent-handoru-owner',64);
    if (!row||!timingSafeEqual(calculated,Buffer.from(row.password_hash,'hex'))) fail('INVALID_LOGIN','Invalid Handle credentials.',401);
    return {id:row.id,email:row.email};
  }
  session(owner:Owner) {
    const token=secret(),csrf=secret();
    this.db.prepare('INSERT INTO handoru_sessions VALUES(?,?,?,?)').run(hash(token),owner.id,csrf,this.time()+12*60*60_000);
    return {token,csrf,owner};
  }
  identifyHuman(cookie:string|undefined):HumanSession|undefined {
    const token=cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('handoru_session='))?.slice(16);
    if (!token||token.length>200) return;
    const row=this.db.prepare('SELECT s.csrf,o.id,o.email FROM handoru_sessions s JOIN handoru_owners o ON o.id=s.owner_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token),this.time()) as Owner&{csrf:string}|undefined;
    return row?{owner:{id:row.id,email:row.email},csrf:row.csrf,hash:hash(token)}:undefined;
  }
  decide(owner:Owner,requestId:string,code:unknown,decision:unknown,scopes:unknown) {
    const row=this.db.prepare('SELECT * FROM handoru_onboarding WHERE id=?').get(requestId) as ReturnType<HandoruStore['onboarding']>|undefined;
    if (!row||row.state!=='pending'||row.expires_at<=this.time()||row.failures>=5) fail('ONBOARDING_UNAVAILABLE','Request expired or already decided.',409);
    if (typeof code!=='string'||hash(`${requestId}:${code}`)!==row.code_hash) {
      this.db.prepare('UPDATE handoru_onboarding SET failures=failures+1 WHERE id=?').run(requestId);fail('PAIRING_CODE_INVALID','Invalid pairing code.',403);
    }
    if (!['approved','rejected'].includes(String(decision))) fail('INVALID_DECISION','Choose approved or rejected.');
    if (!Array.isArray(scopes)||scopes.some(s=>typeof s!=='string'||!AUDIT_SCOPES.includes(s))) fail('INVALID_SCOPES','Initial consent only grants audit and onboarding scopes.');
    return this.db.transaction(()=>{
      const current=this.db.prepare('SELECT state FROM handoru_onboarding WHERE id=?').get(requestId) as {state:string};
      if (current.state!=='pending') fail('ONBOARDING_UNAVAILABLE','Already decided.',409);
      if (decision==='rejected') {this.db.prepare("UPDATE handoru_onboarding SET state='rejected' WHERE id=?").run(requestId);return {state:'rejected'};}
      if(this.ownershipVerification(row,owner).state==='required')fail('OWNERSHIP_PROOF_REQUIRED','Publish the one-time challenge on the legacy website first.',409);
      let business=this.db.prepare('SELECT * FROM handoru_businesses WHERE legacy_url=?').get(row.legacy_url) as Business|undefined;
      if (business) {
        if(this.db.prepare('SELECT 1 FROM handoru_memberships WHERE business_id=?').get(business.id)) this.member(owner,business.id);
        else {
          this.db.prepare('INSERT INTO handoru_memberships VALUES(?,?)').run(owner.id,business.id);
        }
      }
      else {
        business={id:id('business'),legacy_url:row.legacy_url,name:'Pneu 007 (fictional)',active_connection_id:null,execution_epoch:0};
        this.db.prepare('INSERT INTO handoru_businesses VALUES(?,?,?,?,?)').run(business.id,business.legacy_url,business.name,null,0);
        this.db.prepare('INSERT INTO handoru_memberships VALUES(?,?)').run(owner.id,business.id);
        this.db.prepare("INSERT INTO handoru_meta VALUES('installation_business',?)").run(business.id);
      }
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff'").get())this.db.prepare("INSERT INTO staff(id,name,role) VALUES(?,?,'owner') ON CONFLICT(id) DO NOTHING").run(owner.id,owner.email);
      const principal=this.db.prepare('SELECT runtime FROM handoru_principals WHERE id=?').get(row.principal_id) as {runtime:string};
      const connection=id('connection');
      this.db.prepare('INSERT INTO handoru_connections VALUES(?,?,?,?,?,?,NULL)').run(connection,business.id,row.principal_id,principal.runtime,'audit_only',JSON.stringify([...new Set(scopes)]));
      this.db.prepare("UPDATE handoru_onboarding SET state='approved',connection_id=? WHERE id=?").run(connection,requestId);
      this.event(business.id,'connection.consented',owner.id,{connection_id:connection,scopes});
      return {state:'approved',business_id:business.id,connection_id:connection};
    }).immediate();
  }
  exchange(requestId:string,provisional:string) {
    return this.db.transaction(()=>{
      const row=this.onboarding(requestId,provisional);
      if (row.state!=='approved'||!row.connection_id) fail('AUTHORIZATION_PENDING','Waiting for owner consent.',409);
      const c=this.connection(row.connection_id);
      if (['revoked','suspended'].includes(c.state)) fail('CONNECTION_REVOKED','Connection is unavailable.',403);
      const token=this.issue(c.id);
      this.db.prepare("UPDATE handoru_onboarding SET state='exchanged' WHERE id=? AND state='approved'").run(row.id);
      return {access_token:token,token_type:'Bearer',business_id:c.business_id,connection_id:c.id,scopes:JSON.parse(c.scopes_json),credential_audience:new URL(this.publicUrl).origin};
    }).immediate();
  }
  issue(connectionId:string) {
    const token=secret();this.db.prepare('UPDATE handoru_credentials SET revoked=1 WHERE connection_id=?').run(connectionId);
    this.db.prepare('INSERT INTO handoru_credentials VALUES(?,?,0,?)').run(hash(token),connectionId,this.time());return token;
  }
  rotate(token:string,businessId:string,connectionId:string) {
    return this.db.transaction(()=>{
      const actor=this.identify(token);
      if(!actor||actor.connection_id!==connectionId)fail('UNAUTHENTICATED','Current connection credential required.',401);
      this.authorize(actor,businessId,'audit.read');
      const replacement=this.issue(connectionId);this.event(businessId,'credential.rotated',actor.id,{connection_id:connectionId});
      return {access_token:replacement,token_type:'Bearer',business_id:businessId,connection_id:connectionId,credential_audience:new URL(this.publicUrl).origin};
    }).immediate();
  }
  identify(token:string):Actor|undefined {
    const c=this.db.prepare('SELECT c.* FROM handoru_credentials k JOIN handoru_connections c ON c.id=k.connection_id WHERE k.token_hash=? AND k.revoked=0').get(hash(token)) as Connection|undefined;
    if (!c||['revoked','suspended'].includes(c.state)) return;
    const b=this.business(c.business_id);
    return {id:c.principal_id,role:'business_agent',business_id:c.business_id,connection_id:c.id,execution_epoch:b.execution_epoch,scopes:JSON.parse(c.scopes_json)};
  }
  authorize(actor:Actor,businessId:string,scope:string,active=false) {
    if (!actor.connection_id||actor.business_id!==businessId) fail('FORBIDDEN','Scoped business connection required.',403);
    const c=this.connection(actor.connection_id),b=this.business(businessId);
    if (c.principal_id!==actor.id||c.business_id!==businessId||['revoked','suspended'].includes(c.state)||!(JSON.parse(c.scopes_json) as string[]).includes(scope)) fail('FORBIDDEN','Connection or scope is unavailable.',403);
    if (active&&(c.state!=='active'||b.active_connection_id!==c.id||actor.execution_epoch!==b.execution_epoch)) fail('STALE_EXECUTION','Current active connection and execution epoch required.',409);
    if(active)this.validateActive?.(actor,b,c,scope);
    return c;
  }
  operation<T>(actor:Actor,key:string,kind:string,payload:unknown,scope:string,run:()=>T):T {
    return this.db.transaction(()=>{
      this.authorize(actor,actor.business_id!,scope,true);
      text(key,'Idempotency-Key',200);const fingerprint=hash(canonical(payload));
      const old=this.db.prepare('SELECT payload_hash,result_json FROM handoru_operations WHERE business_id=? AND kind=? AND operation_key=?').get(actor.business_id!,kind,key) as {payload_hash:string;result_json:string}|undefined;
      if (old) {if (old.payload_hash!==fingerprint) fail('IDEMPOTENCY_CONFLICT','This operation key has a different payload.',409);return JSON.parse(old.result_json) as T;}
      const result=run();
      if (result instanceof Promise) fail('ASYNC_ATOMIC_OPERATION','External work must follow a committed synchronous operation.',500);
      this.db.prepare('INSERT INTO handoru_operations VALUES(?,?,?,?,?,?,?,?)').run(id('operation'),actor.business_id!,key,kind,fingerprint,actor.connection_id!,actor.execution_epoch!,JSON.stringify(result));
      this.event(actor.business_id!,'operation.accepted',actor.id,{kind,key});return result;
    }).immediate();
  }
  revoke(owner:Owner,businessId:string,connectionId:string) {
    this.member(owner,businessId);const c=this.connection(connectionId);if(c.business_id!==businessId)fail('FORBIDDEN','Foreign connection.',403);
    this.db.transaction(()=>{
      this.db.prepare("UPDATE handoru_connections SET state='revoked' WHERE id=?").run(c.id);
      this.db.prepare('UPDATE handoru_credentials SET revoked=1 WHERE connection_id=?').run(c.id);
      this.db.prepare('UPDATE handoru_businesses SET active_connection_id=NULL,execution_epoch=execution_epoch+1 WHERE id=? AND active_connection_id=?').run(businessId,c.id);
      this.event(businessId,'connection.revoked',owner.id,{connection_id:c.id,external_access_revocation_pending:true});
    }).immediate();
  }
}
