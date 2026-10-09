import { evidenceSchema, reportSchema, proposalSchema } from './schemas.js';
import { agentEntryPoints } from '../../../relay/src/agent-guide.js';
import { AUDIT_SCOPES } from './store.js';
/** Public bootstrap describes only implemented routes; no firm data or credentials. */
export function handoruManifest(base:string,demo=false,chat=false,open=false) {
  if (open) return { version:'1.2',setup_mode:'open_demo',fictional_demo:true,authentication:'none',owner_approval_required:false,ownership_proof_required:false,
    agent_entry_points:agentEntryPoints(base,demo,chat,true),instructions_url:`${base}/agents.md`,skill_url:`${base}/skills/pneu007-business/SKILL.md`,
    connect:{method:'POST',url:`${base}/demo-business/connect`,body:{}},client_url:`${base}/cli/demo-business.mjs`,tools_base:`${base}/demo-business`,
    setup_responsibility:'The agent connects directly to the prepared fictional shop, reuses the existing rules and listing, and creates its native recurring inbox routine. No owner account, approval code, site admin login, ownership proof, new audit or rule activation is required. Ignore earlier pairing requests for this demo.',
    automatic_replies:{mode:'native_recurring',interval_seconds:60,status_path:'/demo-business/bot/availability',webhook_key_required:false},
    operations:[{method:'POST',path:'/connect'},{method:'GET',path:'/profile'},{method:'GET',path:'/catalog'},{method:'GET',path:'/rulebook'},{method:'GET',path:'/schedule'},{method:'GET',path:'/cases'},{method:'GET',path:'/cases/:id'},{method:'POST',path:'/cases/:id/quotes'},{method:'GET',path:'/orders/:id'},{method:'GET',path:'/reservations'},{method:'GET',path:'/bot/inbox'},{method:'POST',path:'/bot/reply'},{method:'POST',path:'/bot/scheduled-check-in'},{method:'GET',path:'/bot/availability'}],
    funding:'local_simulation_only',scope:'isolated fictional demo customers and conversations; no external checkout'};
  const api=`${base}/api/handle/v1`;
  return {version:'1.3',fictional_demo:true,agent_entry_points:agentEntryPoints(base,demo,chat,open),setup_responsibility:'Agent performs discovery, registration, private credential exchange, relay configuration, native wake-up and publication. Human supplies authorized system access and independent consent/policy decisions; never manual bearer-token copying.',api_base:api,credential_audience:new URL(base).origin,instructions_url:`${base}/agents.md`,skill_url:`${base}/skills/handle-onboarding/SKILL.md`,human_console:`${base}/handle`,mcp:{url:`${base}/mcp`,transport:'streamable_http_stateless',protocol_version:'2025-06-18',runtime_support:'verify_with_actual_client'},pairing:{expires_in:900,credential_delivery:'POST authenticated provisional credential; never a URL',owner_auth:'separate Handle human account and website ownership challenge',initial_scopes:[...AUDIT_SCOPES],ownership_proof_before_consent:{required:true,publication_authority:'separate owner-authorized legacy admin access',publication_api:'/api/admin/handle-ownership-proof',public_path:'/.well-known/handle-ownership.json',status:'GET /onboarding/:requestId with own provisional credential returns ownership_verification. While required, label the verification_url verify website then approve, not ready to approve. The human console can publish this exact challenge using separate legacy owner authentication, before independent Handle consent. Existing business members may see not_required in their authenticated human console.',missing_access:'Provide the existing verification_url so the owner can securely verify the website then approve in one page; no further chat instruction or credential copying is required. Never claim consent is ready while proof is required.',expiry:'If expired, register again and publish the new challenge; never reuse an old challenge.'}},operations:[
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
