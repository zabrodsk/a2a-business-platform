import { HandoruStore, id, fail, text, type Owner } from './store.js';
export interface ExternalAccess {system_id:string;state:'verified_revoked'|'controlled_native'|'revocation_pending'|'uncertain_write';evidence:string}
export function prepareHandover(h:HandoruStore,owner:Owner,businessId:string,input:{source_connection_id:string;target_connection_id:string;expected_epoch:number;rulebook_hash:string;external_access:ExternalAccess[]},requiredExternalSystems:string[]) {
  h.member(owner,businessId);const b=h.business(businessId),a=h.connection(text(input.source_connection_id,'source')),target=h.connection(text(input.target_connection_id,'target'));
  if(a.business_id!==businessId||target.business_id!==businessId||a.id===target.id||b.active_connection_id!==a.id||b.execution_epoch!==input.expected_epoch)fail('EPOCH_CONFLICT','Handover source or epoch changed.',409);
  if(['revoked','suspended'].includes(target.state))fail('FORBIDDEN','Target connection unavailable.',403);
  const ready=target.ready_json?JSON.parse(target.ready_json):null;
  if(!ready?.probe_passed||ready.rulebook_hash!==input.rulebook_hash)fail('CAPABILITY_PROBE_REQUIRED','Target has not acknowledged the current context and probe.',409);
  if(!Array.isArray(input.external_access)||input.external_access.some(v=>!v||typeof v.system_id!=='string'||!['verified_revoked','controlled_native','revocation_pending','uncertain_write'].includes(v.state)||typeof v.evidence!=='string'||!v.evidence.trim()))fail('EXTERNAL_ACCESS_EVIDENCE_REQUIRED','Describe native revocation and uncertain writes.');
  const pending=requiredExternalSystems.some(s=>!input.external_access.some(v=>v.system_id===s&&v.state==='verified_revoked'))||input.external_access.some(v=>['revocation_pending','uncertain_write'].includes(v.state));
  const handoff=id('handoff'),state=pending?'external_access_revocation_pending':'prepared';
  h.db.prepare('INSERT INTO handoru_handoffs VALUES(?,?,?,?,?,?,?,?,?)').run(handoff,businessId,a.id,target.id,input.expected_epoch,input.rulebook_hash,state,JSON.stringify(input.external_access),h.now().toISOString());
  h.event(businessId,'handover.prepared',owner.id,{handoff_id:handoff,state});return {id:handoff,state};
}
export function commitHandover(h:HandoruStore,owner:Owner,businessId:string,handoffId:string,currentRulebookHash:string) {
  h.member(owner,businessId);
  return h.db.transaction(()=>{
    const row=h.db.prepare('SELECT * FROM handoru_handoffs WHERE id=? AND business_id=?').get(handoffId,businessId) as {id:string;source_id:string;target_id:string;expected_epoch:number;rulebook_hash:string;state:string}|undefined;
    if(!row)fail('HANDOFF_NOT_FOUND','Unknown handover.',404);
    if(row.state==='committed')return {id:row.id,state:row.state,execution_epoch:row.expected_epoch+1};
    if(row.state!=='prepared')fail('EXTERNAL_ACCESS_REVOCATION_PENDING','Native external revocation/reconciliation is not verified.',409);
    const b=h.business(businessId),target=h.connection(row.target_id),ready=target.ready_json?JSON.parse(target.ready_json):null;
    if(b.active_connection_id!==row.source_id||b.execution_epoch!==row.expected_epoch||currentRulebookHash!==row.rulebook_hash||!ready?.probe_passed||ready.rulebook_hash!==currentRulebookHash||['revoked','suspended'].includes(target.state))fail('HANDOVER_STALE','Business, target, epoch or rulebook changed.',409);
    const source=h.connection(row.source_id);
    const changed=h.db.prepare('UPDATE handoru_businesses SET active_connection_id=?,execution_epoch=execution_epoch+1 WHERE id=? AND execution_epoch=? AND active_connection_id=?').run(target.id,businessId,row.expected_epoch,source.id);
    if(changed.changes!==1)fail('EPOCH_CONFLICT','Another handover won.',409);
    h.db.prepare("UPDATE handoru_connections SET state='revoked' WHERE id=?").run(source.id);
    h.db.prepare('UPDATE handoru_credentials SET revoked=1 WHERE connection_id=?').run(source.id);
    h.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id=?").run(source.scopes_json,target.id);
    h.db.prepare("UPDATE handoru_handoffs SET state='committed' WHERE id=?").run(row.id);
    h.event(businessId,'handover.committed',owner.id,{handoff_id:row.id,source_id:source.id,target_id:target.id,epoch:row.expected_epoch+1});
    return {id:row.id,state:'committed',execution_epoch:row.expected_epoch+1};
  }).immediate();
}
