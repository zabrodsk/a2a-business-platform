import { evidenceSchema, reportSchema, proposalSchema } from './schemas.js';
import { agentEntryPoints } from '../../../relay/src/agent-guide.js';
/** Public bootstrap describes only implemented routes; no firm data or credentials. */
export function handoruManifest(base:string,demo=false,chat=false) {
  const api=`${base}/api/handle/v1`;
  return {version:'1.2',fictional_demo:true,agent_entry_points:agentEntryPoints(base,demo,chat),setup_responsibility:'Agent performs discovery, registration, private credential exchange, relay configuration, native wake-up and publication. Human supplies authorized system access and independent consent/policy decisions; never manual bearer-token copying.',api_base:api,credential_audience:new URL(base).origin,instructions_url:`${base}/agents.md`,skill_url:`${base}/skills/handle-onboarding/SKILL.md`,human_console:`${base}/handle`,mcp:{url:`${base}/mcp`,transport:'streamable_http_stateless',protocol_version:'2025-06-18',runtime_support:'verify_with_actual_client'},pairing:{expires_in:900,credential_delivery:'POST authenticated provisional credential; never a URL',owner_auth:'separate Handle human account and website ownership challenge'},operations:[
    {method:'POST',path:'/agent-registrations',scope:'public',input:{runtime:'string',legacy_url:'website origin'}},
    {method:'GET',path:'/onboarding/:requestId',scope:'own_provisional'},
    {method:'POST',path:'/onboarding/:requestId/credentials',scope:'own_provisional'},
    {method:'GET',path:'/me',scope:'audit.read'},
    {method:'POST',path:'/businesses/:businessId/connections/:connectionId/credentials/rotate',scope:'audit.read',current_credential_required:true},
    {method:'POST',path:'/businesses/:businessId/relay',scope:'relay.provision',idempotency_key:true},
    {method:'GET',path:'/businesses/:businessId/relay',scope:'relay.provision'},
    {method:'POST',path:'/businesses/:businessId/relay/probe',scope:'relay.provision',input:{phase:'onboarding|rulebook (default: rulebook)'},phases:{onboarding:'Private pre-audit G0; no active rulebook required; grants no operation authority.',rulebook:'Policy-bound readiness; requires exact active rulebook hash in answer before separate human operation authorization.'}},
    {method:'GET',path:'/businesses/:businessId/relay/probe/inbox',scope:'relay.provision'},
    {method:'POST',path:'/businesses/:businessId/relay/probe/answer',scope:'relay.provision',input:{nonce:'private probe nonce',phase:'optional; must match stored challenge phase',rulebook_hash:'required only for rulebook phase: active reviewed payload hash',method:'polling|routine|wake_up',evidence:'actual capability description'}},
    {method:'GET',path:'/businesses/:businessId/capabilities',scope:'audit.read'},
    {method:'POST',path:'/businesses/:businessId/audit-evidence',scope:'audit.propose'},
    {method:'POST',path:'/businesses/:businessId/audit-reports',scope:'audit.propose'},
    {method:'POST',path:'/businesses/:businessId/source-checks',scope:'audit.propose'},
    {method:'POST',path:'/businesses/:businessId/rulebook/proposals',scope:'audit.propose'},
    {method:'GET',path:'/businesses/:businessId/context',scope:'context.read'},
    {method:'GET',path:'/businesses/:businessId/events',scope:'context.read'},
    {method:'POST',path:'/businesses/:businessId/website-publications',scope:'website.agent-card.publish',idempotency_key:true},
    {method:'POST',path:'/businesses/:businessId/website-publications/:publicationId/verify',scope:'website.agent-card.publish'},
  ],audit_evidence_schema:evidenceSchema,audit_report_schema:reportSchema,rulebook_submission_schema:proposalSchema,limits:{request_bytes:3_000_000,pairing_seconds:900,probe_seconds:300,live_source_check_seconds:300},errors:['HUMAN_REQUIRED','OWNERSHIP_PROOF_REQUIRED','FORBIDDEN','STALE_EXECUTION','RULEBOOK_INACTIVE','RULEBOOK_HASH_MISMATCH','IDEMPOTENCY_CONFLICT','EXTERNAL_ACCESS_REVOCATION_PENDING'],raw_http_example:{method:'POST',url:`${api}/agent-registrations`,headers:{'content-type':'application/json'},body:{runtime:'GrokBot',legacy_url:base}}};
}
