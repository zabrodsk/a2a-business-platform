import type { Actor } from '../../../../packages/contracts/index.js';
import { HandoruStore, hash, id, ALL_SCOPES, AUDIT_SCOPES, fail, text, type Owner } from './store.js';

/** One-time additive import. Persisting the marker prevents an env token resurrecting revoked access. */
export function importCompatibility(h:HandoruStore,tokens:Map<string,Actor>,fresh:boolean) {
  if(fresh||h.db.prepare("SELECT 1 FROM handoru_meta WHERE key='compatibility_imported'").get())return;
  const entry=[...tokens].find(([,a])=>a.role==='business_agent');if(!entry)return;
  h.db.transaction(()=>{
    const [token,a]=entry,businessId='pneu007',connectionId='compatibility-pneu007';
    const hasAuditTable=h.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_rulebook_versions'").get();
    const approved=Boolean(hasAuditTable&&h.db.prepare("SELECT 1 FROM audit_rulebook_versions WHERE status='active' LIMIT 1").get());
    if(h.installation())return;
    h.db.prepare('INSERT INTO handoru_businesses VALUES(?,?,?,?,?)').run(businessId,new URL(h.publicUrl).origin,'Pneu 007 (fictional)',approved?connectionId:null,approved?1:0);
    h.db.prepare('INSERT INTO handoru_principals VALUES(?,?)').run(a.id,'legacy-compatibility');
    h.db.prepare('INSERT INTO handoru_connections VALUES(?,?,?,?,?,?,NULL)').run(connectionId,businessId,a.id,'legacy-compatibility',approved?'active':'audit_only',JSON.stringify(approved?ALL_SCOPES:AUDIT_SCOPES));
    h.db.prepare('INSERT INTO handoru_credentials VALUES(?,?,0,?)').run(hash(token),connectionId,h.time());
    h.db.prepare("INSERT INTO handoru_meta VALUES('installation_business',?)").run(businessId);
    h.db.prepare("INSERT INTO handoru_meta VALUES('compatibility_imported','1')").run();
    h.event(businessId,'migration.compatibility_imported','system',{connection_id:connectionId});
  }).immediate();
}
export function provisionRelay(h:HandoruStore,actor:Actor,businessId:string,key:string,relayBase:string) {
  h.authorize(actor,businessId,'relay.provision');text(key,'Idempotency-Key');
  return h.db.transaction(()=>{
    const existing=h.db.prepare('SELECT * FROM handoru_relays WHERE business_id=?').get(businessId);if(existing)return existing;
    const relayId=id('relay'),base=`${relayBase.replace(/\/$/,'')}/relay/${relayId}`;
    h.db.prepare('INSERT INTO handoru_relays(id,business_id,endpoint,inbox) VALUES(?,?,?,?)').run(relayId,businessId,`${base}/a2a`,`${base}/bot`);
    h.event(businessId,'relay.provisioned',actor.id,{relay_id:relayId});return h.db.prepare('SELECT * FROM handoru_relays WHERE id=?').get(relayId);
  }).immediate();
}
export function authorizeOperation(h:HandoruStore,owner:Owner,businessId:string,connectionId:string,input:{scopes:unknown;expected_epoch:unknown},rulebookHash:string) {
  h.member(owner,businessId);
  return h.db.transaction(()=>{
    const b=h.business(businessId),c=h.connection(connectionId);
    if(c.business_id!==businessId||['revoked','suspended'].includes(c.state))fail('FORBIDDEN','Unavailable connection.',403);
    if(input.expected_epoch!==b.execution_epoch)fail('EPOCH_CONFLICT','Reload the current business state.',409);
    if(!Array.isArray(input.scopes)||input.scopes.some(s=>!ALL_SCOPES.includes(s)))fail('INVALID_SCOPES','Unsupported operation scopes.');
    const evidence=c.ready_json?JSON.parse(c.ready_json):null;
    if(!evidence||evidence.probe_passed!==true||evidence.rulebook_hash!==rulebookHash)fail('CAPABILITY_PROBE_REQUIRED','Connection must prove current inbox capability and acknowledge this exact rulebook.',409);
    if(b.active_connection_id&&b.active_connection_id!==c.id)fail('HANDOVER_REQUIRED','Use owner-approved handover to replace the active connection.',409);
    const epoch=b.active_connection_id===c.id?b.execution_epoch:b.execution_epoch+1;
    h.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id=?").run(JSON.stringify([...new Set([...AUDIT_SCOPES,...input.scopes])]),c.id);
    h.db.prepare('UPDATE handoru_businesses SET active_connection_id=?,execution_epoch=? WHERE id=?').run(c.id,epoch,b.id);
    h.event(businessId,'connection.operation_authorized',owner.id,{connection_id:c.id,scopes:input.scopes,rulebook_hash:rulebookHash,epoch});
    return {connection_id:c.id,execution_epoch:epoch};
  }).immediate();
}
