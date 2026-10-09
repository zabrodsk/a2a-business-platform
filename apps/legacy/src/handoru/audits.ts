import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BusinessError, type Actor } from '../../../../packages/contracts/index.js';
import {
  SourceRegistry, RulebookManager, auditPayloadHash, ensureAuditSchema, sourceArchiveHash, sourceArchiveVersion, rulebookFields,
  type Source, type Citation, type RulebookParams, type RulebookProposal, type RulebookVersion,
} from '../../../../packages/audit/index.js';

export type AuditAction = 'read' | 'write' | 'approve';
export type AuditMethod = 'browser' | 'api' | 'mcp' | 'document' | 'owner';
export interface EvidenceInput {
  system_id: string; url: string; locator: string; captured_at: string; method: AuditMethod;
  content_type: 'text/plain' | 'application/json' | 'image/png' | 'image/jpeg';
  /** Redacted text, or a caption for an image requiring human visual interpretation. */
  content: string; attachment_base64?: string; native_revision?: string; redacted: true;
}
export interface AuditSystem {
  id: string; name: string; url: string; purpose: string;
  access_methods: AuditMethod[]; observed_roles: string[]; fact_authority: string[];
}
export interface AuditQuestion {
  id: string; question: string; critical: boolean; affected_parameters: (keyof RulebookParams)[];
  citations: Citation[];
}
export interface AuditReportInput {
  schema_version: '1.0'; title: string; summary: string; systems: AuditSystem[];
  processes: {id:string; description:string; citations:Citation[]}[];
  findings: {id:string; severity:'info'|'warning'|'critical'; description:string; recommendation:string; affected_parameters:(keyof RulebookParams)[]; citations:Citation[]}[];
  questions: AuditQuestion[];
  supported_writes: {action:string; system_id:string; mode:'audit_only'|'assisted'|'native_enforced'; description:string; citations:Citation[]}[];
}
export interface AuditReport extends AuditReportInput {
  version: number; business_id: string; payload_hash: string; created_at: string; proposed_by: string;
}
export interface OwnerAnswerInput {
  report_version: number; question_id: string; answer: string;
  kind: 'policy_decision' | 'external_fact'; scope: string; valid_until?: string;
}
export interface OwnerAnswer extends OwnerAnswerInput {
  version: number; business_id: string; created_at: string; answered_by: string; evidence: Source;
}
export interface FreshnessInput {
  source_id: string; status: 'current'|'changed'|'unknown'|'unavailable'; method: AuditMethod;
  /** A new redacted read, not the archive hash. Current/changed checks require it. */
  observed_content?: string; observed_attachment_base64?: string; native_revision?: string;
}
export interface EvidenceCheck {
  source_id: string; status: FreshnessInput['status']; method: AuditMethod; checked_at: string;
  expires_at: string; observed_hash?: string; native_revision?: string;
  verification: 'agent_reported_reread' | 'human_reported_reread';
}
export interface RulebookSubmission {
  report_version: number;
  proposal: RulebookProposal;
  source_authority: Record<string,'policy_decision'|'external_fact'|'observation'>;
  required_capabilities?: string[];
}
interface RecordRow {
  version:number; business_id:string; status:string; proposed_by:string; created_at:string;
  payload_json:string; manifest_json:string; activated_by:string|null; activated_at:string|null;
}
const methods = ['browser','api','mcp','document','owner'];
function fail(code:string,message:string,status=422):never { throw new BusinessError(code,message,status); }
function object(value:unknown,allowed:string[],required=allowed):asserts value is Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)) || required.some(key=>!Object.hasOwn(value,key))) fail('INVALID_AUDIT','Missing or unsupported audit fields');
}
function text(value:unknown,label:string,max=4000):asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length>max) fail('INVALID_AUDIT',`Invalid ${label}`);
}
function identifier(value:unknown,label:string):asserts value is string {
  text(value,label,200); if (!/^[\p{L}\p{N}_.:-]+$/u.test(value)) fail('INVALID_AUDIT',`Invalid ${label}`);
}
function date(value:unknown,label:string):asserts value is string {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_AUDIT',`Invalid ${label}`);
}
function url(value:unknown):asserts value is string {
  text(value,'source URL',2000);
  try { const parsed=new URL(value); if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key=>/token|password|secret|api.?key|session|credential/i.test(key))) throw Error(); }
  catch { fail('INVALID_AUDIT','Expected an HTTP(S) URL without credentials'); }
}
function safeContent(content:string):void {
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:password|api[_-]?key|access[_-]?token|authorization|cookie|secret|mnemonic|token|private_key|credentials|session_id|refresh_token|password_hash)\s*[=:]\s*(?!\[REDACTED\]|<redacted>|redacted\b|"?\[REDACTED\])[^\s,;}]{3,}/i.test(content)
    || /"(?:password|api_key|access_token|authorization|cookie|secret|mnemonic|token|private_key|credentials|session_id|refresh_token|password_hash)"\s*:\s*"(?!\[REDACTED\]"|<redacted>"|redacted")[^"]{3,}"/i.test(content)) fail('UNREDACTED_EVIDENCE','Remove credentials from evidence before uploading');
}
function imageBytes(value:unknown):Buffer {
  if (typeof value!=='string' || value.length>2_800_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_AUDIT','Invalid image attachment');
  const bytes=Buffer.from(value,'base64'); if (!bytes.length || bytes.toString('base64')!==value) fail('INVALID_AUDIT','Invalid image attachment'); return bytes;
}
function parameters(value:unknown):asserts value is (keyof RulebookParams)[] {
  if (!Array.isArray(value) || value.length>rulebookFields.length || value.some(key=>!rulebookFields.includes(key)) || new Set(value).size!==value.length) fail('INVALID_AUDIT','Invalid affected parameters');
}
function array(value:unknown,label:string,max=100):asserts value is unknown[] {
  if (!Array.isArray(value) || value.length>max) fail('INVALID_AUDIT',`Invalid ${label}`);
}
function strings(value:unknown,label:string):asserts value is string[] {
  array(value,label,40); value.forEach(entry=>text(entry,label,300));
}

/** Business-owned archive/report storage. Authorization must come from the current platform principal. */
export class HandoruAudits {
  readonly registry: SourceRegistry;
  readonly rulebooks: RulebookManager;
  readonly now:()=>Date;
  constructor(readonly db:Database.Database,readonly businessId:string,readonly options:{authorize:(actor:Actor,action:AuditAction)=>void;now?:()=>Date}) {
    identifier(businessId,'business_id'); ensureAuditSchema(db); this.now=options.now??(()=>new Date());
    this.registry=new SourceRegistry(undefined,[],false);
    this.rulebooks=new RulebookManager(db,this.registry,{businessId,genericEvidence:true,now:this.now});
  }
  private access(actor:Actor,action:AuditAction) {
    this.options.authorize(actor,action);
    if (action==='approve' && actor.role!=='owner') fail('FORBIDDEN','Only the independently authenticated human owner can decide',403);
    if (action==='write' && actor.role!=='business_agent') fail('FORBIDDEN','Only a bound business agent can submit an audit',403);
  }
  private record(kind:string,actor:Actor,payload:unknown,manifest:unknown=[]):RecordRow {
    const inserted=this.db.prepare('INSERT INTO audit_rulebook_versions(status,proposed_by,created_at,payload_json,manifest_json,business_id,record_kind) VALUES(?,?,?,?,?,?,?)').run('archived',actor.id,this.now().toISOString(),JSON.stringify(payload),JSON.stringify(manifest),this.businessId,kind);
    return this.db.prepare('SELECT * FROM audit_rulebook_versions WHERE version=? AND business_id=?').get(inserted.lastInsertRowid,this.businessId) as RecordRow;
  }
  private row(kind:string,version:number):RecordRow {
    if (!Number.isSafeInteger(version) || version<1) fail('INVALID_AUDIT','Invalid record version');
    const row=this.db.prepare('SELECT * FROM audit_rulebook_versions WHERE version=? AND business_id=? AND record_kind=?').get(version,this.businessId,kind) as RecordRow|undefined;
    if (!row) fail('AUDIT_RECORD_NOT_FOUND','Unknown business audit record',404); return row;
  }
  private rows(kind:string):RecordRow[] {
    return this.db.prepare('SELECT * FROM audit_rulebook_versions WHERE business_id=? AND record_kind=? ORDER BY version DESC').all(this.businessId,kind) as RecordRow[];
  }
  private source(sourceId:string):Source {
    identifier(sourceId,'source_id');
    const row=this.db.prepare('SELECT source_json FROM audit_source_snapshots WHERE business_id=? AND source_id=?').get(this.businessId,sourceId) as {source_json:string}|undefined;
    if (!row) fail('SOURCE_NOT_FOUND','Unknown business evidence',404);
    const source=JSON.parse(row.source_json) as Source;
    if (sourceArchiveHash(source)!==source.hash || (source.archive_integrity && sourceArchiveVersion(source)!==source.version)) fail('ARCHIVE_INTEGRITY_FAILED','Archived evidence bytes were modified',409);
    return source;
  }
  private archive(actor:Actor,input:EvidenceInput):Source {
    object(input,['system_id','url','locator','captured_at','method','content_type','content','attachment_base64','native_revision','redacted'],['system_id','url','locator','captured_at','method','content_type','content','redacted']);
    identifier(input.system_id,'system_id'); url(input.url); text(input.locator,'locator',2000); date(input.captured_at,'captured_at');
    if (Date.parse(input.captured_at)>this.now().getTime()+60_000 || !methods.includes(input.method) || input.redacted!==true) fail('INVALID_AUDIT','Invalid capture method/time or missing redaction acknowledgement');
    text(input.content,'evidence text/caption',1_000_000); safeContent(JSON.stringify(input));
    if (input.native_revision!==undefined) text(input.native_revision,'native_revision',300);
    const image=input.content_type==='image/png'||input.content_type==='image/jpeg';
    if (!image && !['text/plain','application/json'].includes(input.content_type)) fail('INVALID_AUDIT','Unsupported content type');
    if (image) {
      const bytes=imageBytes(input.attachment_base64);
      if (input.content_type==='image/png' ? bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' : bytes.subarray(0,3).toString('hex')!=='ffd8ff') fail('INVALID_AUDIT','Image bytes do not match the declared content type');
    } else if (input.attachment_base64!==undefined) fail('INVALID_AUDIT','Text evidence cannot contain an image attachment');
    if (input.content_type==='application/json') { try { JSON.parse(input.content); } catch { fail('INVALID_AUDIT','Invalid JSON evidence'); } }
    const hash=createHash('sha256').update(image?imageBytes(input.attachment_base64):input.content).digest('hex');
    const source:Source={source_id:`evidence-${randomUUID()}`,business_id:this.businessId,version:auditPayloadHash(input),hash,
      content:input.content,...(image?{attachment_base64:input.attachment_base64}:{}),visibility:'internal',effective_from:input.captured_at,
      authority:input.method==='owner'?'human-owner-statement':'agent-observation-unreviewed',current:true,url:input.url,archive_integrity:'verified',
      capture:{system_id:input.system_id,locator:input.locator,captured_at:input.captured_at,method:input.method,content_type:input.content_type,...(input.native_revision?{native_revision:input.native_revision}:{})}};
    source.version=sourceArchiveVersion(source);
    this.db.prepare('INSERT INTO audit_source_snapshots(source_id,source_json,business_id) VALUES(?,?,?)').run(source.source_id,JSON.stringify(source),this.businessId);
    this.registry.restoreSnapshot(source); return source;
  }
  archiveEvidence(actor:Actor,input:EvidenceInput):Source {
    this.access(actor,'write'); if (input?.method==='owner') fail('FORBIDDEN','Agents cannot manufacture human evidence',403); return this.archive(actor,input);
  }
  getEvidence(actor:Actor,sourceId:string):Source { this.access(actor,'read'); return this.source(sourceId); }
  listEvidence(actor:Actor):Source[] { this.access(actor,'read'); return (this.db.prepare('SELECT source_id FROM audit_source_snapshots WHERE business_id=?').all(this.businessId) as {source_id:string}[]).map(row=>this.source(row.source_id)); }
  private citations(value:unknown):asserts value is Citation[] {
    array(value,'citations',50);
    for (const item of value) {
      object(item,['source_id','version','hash','excerpt']); const citation=item as unknown as Citation;
      text(citation.excerpt,'citation excerpt',12000); const source=this.source(citation.source_id);
      if (!source.archive_integrity || !source.capture) fail('INVALID_AUDIT','Capture source provenance before citing it in a generic report');
      if (source.version!==citation.version || source.hash!==citation.hash) fail('STALE_SOURCE','Citation does not match archived evidence',409);
      if (!source.content.includes(citation.excerpt)) fail('UNSUPPORTED_CITATION','Citation excerpt does not occur in the archived text/caption');
    }
  }
  private report(row:RecordRow):AuditReport { return {...JSON.parse(row.payload_json),version:row.version,business_id:row.business_id,payload_hash:auditPayloadHash(JSON.parse(row.payload_json)),created_at:row.created_at,proposed_by:row.proposed_by}; }
  createReport(actor:Actor,input:AuditReportInput):AuditReport {
    this.access(actor,'write'); object(input,['schema_version','title','summary','systems','processes','findings','questions','supported_writes']);
    if (input.schema_version!=='1.0') fail('INVALID_AUDIT','Unsupported audit schema');
    text(input.title,'title',200); text(input.summary,'summary',12000); safeContent(input.summary);
    array(input.systems,'systems',40); if (!input.systems.length) fail('INVALID_AUDIT','An audit needs its observed system inventory');
    const ids=new Set<string>();
    for (const system of input.systems) {
      object(system,['id','name','url','purpose','access_methods','observed_roles','fact_authority']); identifier(system.id,'system id');
      if (ids.has(system.id)) fail('INVALID_AUDIT','Duplicate system id'); ids.add(system.id);
      text(system.name,'system name',200); url(system.url); text(system.purpose,'system purpose'); strings(system.access_methods,'access methods');
      if (!system.access_methods.length || system.access_methods.some(method=>!methods.includes(method))) fail('INVALID_AUDIT','Invalid access method');
      strings(system.observed_roles,'observed roles'); strings(system.fact_authority,'fact authority');
    }
    for (const [field,keys] of [['processes',['id','description','citations']],['findings',['id','severity','description','recommendation','affected_parameters','citations']],['questions',['id','question','critical','affected_parameters','citations']],['supported_writes',['action','system_id','mode','description','citations']]] as const) {
      array(input[field],field,100); const unique=new Set<string>();
      for (const entry of input[field]) {
        object(entry,[...keys]); this.citations(entry.citations);
        const id=field==='supported_writes'?(entry as AuditReportInput['supported_writes'][number]).action:(entry as {id:string}).id;
        identifier(id,`${field} id`); if (unique.has(id)) fail('INVALID_AUDIT','Duplicate report entry'); unique.add(id);
        if ('description' in entry) text(entry.description,`${field} description`);
        if ('affected_parameters' in entry) parameters(entry.affected_parameters);
        if ('severity' in entry && !['info','warning','critical'].includes(entry.severity)) fail('INVALID_AUDIT','Invalid finding severity');
        if ('recommendation' in entry) text(entry.recommendation,'recommendation');
        if ('question' in entry) { text(entry.question,'question'); if (!('critical' in entry)||typeof entry.critical!=='boolean') fail('INVALID_AUDIT','Invalid question critical flag'); }
        if ('mode' in entry && (!['audit_only','assisted','native_enforced'].includes(entry.mode) || !ids.has(entry.system_id))) fail('INVALID_AUDIT','Invalid supported write mode/system');
        if ((field==='processes'||field==='supported_writes')&&!entry.citations.length) fail('MISSING_AUDIT_EVIDENCE','Observed processes/actions need evidence');
        for (const citation of entry.citations) if (!ids.has(this.source(citation.source_id).capture!.system_id)) fail('INVALID_AUDIT','Cited evidence must refer to an inventoried system');
      }
    }
    safeContent(JSON.stringify(input));
    const cited=[...input.processes,...input.findings,...input.questions,...input.supported_writes].flatMap(item=>item.citations);
    return this.report(this.record('report',actor,input,[...new Map(cited.map(c=>[c.source_id,{source_id:c.source_id,version:c.version,hash:c.hash}])).values()]));
  }
  listReports(actor:Actor):AuditReport[] { this.access(actor,'read'); return this.rows('report').map(row=>this.report(row)); }
  getReport(actor:Actor,version:number):AuditReport { this.access(actor,'read'); return this.report(this.row('report',version)); }
  answerQuestion(actor:Actor,input:OwnerAnswerInput):OwnerAnswer {
    this.access(actor,'approve'); object(input,['report_version','question_id','answer','kind','scope','valid_until'],['report_version','question_id','answer','kind','scope']);
    const report=this.report(this.row('report',input.report_version)); identifier(input.question_id,'question_id');
    if (!report.questions.some(question=>question.id===input.question_id)) fail('AUDIT_QUESTION_NOT_FOUND','Unknown report question',404);
    text(input.answer,'answer',12000); text(input.scope,'scope',2000); safeContent(JSON.stringify(input));
    if (!['policy_decision','external_fact'].includes(input.kind)) fail('INVALID_AUDIT','Invalid owner answer kind');
    if (input.valid_until!==undefined) { date(input.valid_until,'valid_until'); if (Date.parse(input.valid_until)<=this.now().getTime()) fail('INVALID_AUDIT','Answer validity must end in the future'); }
    return this.db.transaction(()=>{
      const system=report.systems[0]!;
      const evidence=this.archive(actor,{system_id:system.id,url:system.url,locator:`Human answer to report ${report.version}, question ${input.question_id}; scope: ${input.scope}`,captured_at:this.now().toISOString(),method:'owner',content_type:'text/plain',content:input.answer,redacted:true});
      const row=this.record('owner_answer',actor,{...input,evidence_id:evidence.source_id});
      return {...input,version:row.version,business_id:this.businessId,created_at:row.created_at,answered_by:actor.id,evidence};
    })();
  }
  listAnswers(actor:Actor,reportVersion?:number):OwnerAnswer[] {
    this.access(actor,'read'); if (reportVersion!==undefined) this.row('report',reportVersion);
    return this.rows('owner_answer').flatMap(row=>{
      const {evidence_id,...input}=JSON.parse(row.payload_json) as OwnerAnswerInput & {evidence_id:string};
      return reportVersion!==undefined&&input.report_version!==reportVersion?[]:[{...input,version:row.version,business_id:this.businessId,created_at:row.created_at,answered_by:row.proposed_by,evidence:this.source(evidence_id)}];
    });
  }
  recordFreshness(actor:Actor,input:FreshnessInput):EvidenceCheck {
    this.access(actor,'write'); object(input,['source_id','status','method','observed_content','observed_attachment_base64','native_revision'],['source_id','status','method']);
    const source=this.source(input.source_id);
    if (!['current','changed','unknown','unavailable'].includes(input.status)||!methods.includes(input.method)||input.method==='owner') fail('INVALID_AUDIT','Invalid source check');
    if (input.native_revision!==undefined) text(input.native_revision,'native_revision',300);
    safeContent(JSON.stringify(input));
    let observed_hash:string|undefined;
    if (input.status==='current'||input.status==='changed') {
      if (source.attachment_base64) observed_hash=createHash('sha256').update(imageBytes(input.observed_attachment_base64)).digest('hex');
      else { text(input.observed_content,'freshly observed content',1_000_000); safeContent(input.observed_content); observed_hash=createHash('sha256').update(input.observed_content).digest('hex'); }
      if ((observed_hash===source.hash)!==(input.status==='current')) fail('INVALID_EVIDENCE_CHECK','Reported status disagrees with the newly observed bytes');
      if (input.status==='current' && source.capture?.native_revision && input.native_revision!==source.capture.native_revision) fail('INVALID_EVIDENCE_CHECK','Native revision changed or was not checked');
    } else if (input.observed_content!==undefined||input.observed_attachment_base64!==undefined) fail('INVALID_EVIDENCE_CHECK','Unknown/unavailable check cannot assert observed content');
    const check:EvidenceCheck={source_id:source.source_id,status:input.status,method:input.method,checked_at:this.now().toISOString(),expires_at:new Date(this.now().getTime()+300_000).toISOString(),...(observed_hash?{observed_hash}:{}),...(input.native_revision?{native_revision:input.native_revision}:{}),verification:'agent_reported_reread'};
    this.record('freshness_check',actor,check); return check;
  }
  getFreshness(actor:Actor,sourceId:string):EvidenceCheck|{source_id:string;status:'unknown';checked_at:null;verification:'not_checked'} {
    this.access(actor,'read'); this.source(sourceId);
    const check=this.rows('freshness_check').map(row=>JSON.parse(row.payload_json) as EvidenceCheck).find(value=>value.source_id===sourceId);
    return check?{...check,...(Date.parse(check.expires_at)<=this.now().getTime()?{status:'unknown' as const}:{})}:{source_id:sourceId,status:'unknown',checked_at:null,verification:'not_checked'};
  }
  proposeRulebook(actor:Actor,input:RulebookSubmission):RulebookVersion {
    this.access(actor,'write'); object(input,['report_version','proposal','source_authority','required_capabilities'],['report_version','proposal','source_authority']);
    object(input.proposal,['profile','params','evidence','findings','governance'],['profile','params','evidence','findings']);
    object(input.proposal.evidence,[...rulebookFields]);
    array(input.proposal.findings,'findings'); safeContent(JSON.stringify(input));
    const report=this.report(this.row('report',input.report_version));
    const answers=this.listAnswers(actor,report.version);
    const blocked=new Set<keyof RulebookParams>();
    for (const question of report.questions.filter(question=>question.critical)) {
      const answer=answers.find(value=>value.question_id===question.id);
      if (!answer || (answer.valid_until && Date.parse(answer.valid_until)<=this.now().getTime())) for (const key of question.affected_parameters.length?question.affected_parameters:rulebookFields) blocked.add(key);
      else for (const key of question.affected_parameters) {
        if (!input.proposal.evidence[key]?.some(citation=>citation.source_id===answer.evidence.source_id)) blocked.add(key);
      }
    }
    if (input.proposal.findings?.some(finding=>finding.severity==='critical')) for (const key of rulebookFields) blocked.add(key);
    for (const finding of report.findings.filter(finding=>finding.severity==='critical')) for (const key of finding.affected_parameters.length?finding.affected_parameters:rulebookFields) blocked.add(key);
    const proposal:RulebookProposal={...input.proposal,governance:{report_version:report.version,blocked_parameters:[...blocked],source_authority:input.source_authority,required_capabilities:input.required_capabilities??[]}};
    // Refresh sources added by a concurrent request before validating the immutable citations.
    this.rulebooks.useBusiness(this.businessId,{genericEvidence:true});
    return this.rulebooks.propose(actor,proposal);
  }
  activateRulebook(actor:Actor,input:{version:number;payload_hash:string}):RulebookVersion {
    this.access(actor,'approve'); object(input,['version','payload_hash']); text(input.payload_hash,'payload_hash',64);
    return this.rulebooks.activate(actor,input.version,input.payload_hash);
  }
  context(actor:Actor):{business_id:string;reports:AuditReport[];answers:OwnerAnswer[];rulebooks:RulebookVersion[];evidence:Source[];source_checks:(EvidenceCheck|{source_id:string;status:'unknown';checked_at:null;verification:'not_checked'})[];cursor:number} {
    this.access(actor,'read'); const evidence=this.listEvidence(actor);
    const cursor=(this.db.prepare('SELECT COALESCE(MAX(version),0) AS cursor FROM audit_rulebook_versions WHERE business_id=?').get(this.businessId) as {cursor:number}).cursor;
    return {business_id:this.businessId,reports:this.listReports(actor),answers:this.listAnswers(actor),rulebooks:this.rulebooks.list(),evidence,source_checks:evidence.map(source=>this.getFreshness(actor,source.source_id)),cursor};
  }
}
