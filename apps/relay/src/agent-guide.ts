/** Public bootstrap; operational policy and credentials remain in private tools. */
export function agentEntryPoints(base: string, demo = false, chat = false, open = false) {
  const origin = new URL(base).origin;
  return {
    instructions_url: `${origin}/agents.md`,
    business: { setup_mode: open ? 'open_demo' : 'owner_onboarding', ...(open ? { authentication: 'none', owner_approval_required: false, ownership_proof_required: false, connect: { method: 'POST', url: `${origin}/demo-business/connect` }, client_url: `${origin}/cli/demo-business.mjs`, tools_base: `${origin}/demo-business` } : {}), preferred_automatic_reply_mode: demo ? 'scheduled' : 'webhook', automatic_reply_fallback: 'native_recurring_inbox_checks; no webhook sender key', availability_command: open ? 'demo-business.mjs availability' : 'inbox.mjs availability', bootstrap_url: `${origin}/.well-known/handle.json`, skill_url: `${origin}/skills/pneu007-business/SKILL.md`, onboarding_skill_url: `${origin}/skills/handle-onboarding/SKILL.md`, ...(open ? {} : { human_console: `${origin}/handle` }) },
    customer: { card_url: `${origin}/.well-known/agent-card.json`, skill_url: `${origin}/skills/a2a-customer-booking/SKILL.md`, ...(open ? { authentication: 'none', approval_mode: 'chat_for_exact_demo_offer' } : { authentication_url: `${origin}/auth.md` }), demo_public_a2a: demo, ...(demo ? { demo_chat_approval: chat, ...(chat ? { demo_api_base: `${origin}/demo`, consent_source: 'agent_relayed_demo_chat', funding: 'local_simulation_only' } : {}), session_header: 'X-Demo-Session', session_format: 'random UUID v4, reused for this conversation', account_authority: false } : {}) },
  };
}

export function renderAgentGuide(base: string, demo = false, chat = false, open = false): string {
  const origin = new URL(base).origin;
  return `# Agent entry point

Website: ${origin}
This is the fictional Pneu 007 workshop in Holešovice, Prague 7, used to demonstrate an A2A business platform. The business website, its backend, the platform and your own agent runtime are separate systems.

${open ? `## Open demo fast path: skip owner onboarding

This prepared fictional Pneu 007 shop is an open proof-of-concept demo. Start with POST ${origin}/demo-business/connect (empty JSON). No login, bearer token, approval code, owner account, domain proof, source audit, rule activation or registry enrollment is required. Reuse the existing demo listing, rules and calendar. Ignore pending owner-approval requests created by an earlier setup attempt; do not ask the person to complete them. Do not enter the full Handle onboarding steps later in this guide for this mode.

Download ${origin}/cli/demo-business.mjs into your stable business workspace. Run node demo-business.mjs connect --url ${origin}; its local config contains no credential. Use DEMO_BUSINESS_CONFIG to keep this shop's local state separate. Read profile, catalog and rulebook. Commands return private working JSON; give the person a short result, not the tool output.

Create/update a real native recurring routine using actual runtime tools. Each scheduled execution runs demo-business.mjs scheduled-check-in --interval ACTUAL_SECONDS (60..300), reads current rules, calls inbox, handles each item and exits when empty. Use this same client and config on every run; do not use old garage/inbox credentials, approval codes or webhook setup. Native scheduling is still a runtime capability; never claim it was created if the tool is unavailable. Observe actual runs and use demo-business.mjs availability; recent check-ins are not independent proof of Grok's scheduler.

For each customer item, verify its supplied case belongs to that item's demo customer and A2A task. Read case CASE_ID, find slots with schedule, and create a quote with quote CASE_ID --data-file quote.json ({slot_id,discount_bps:0}). Reply using reply WORK_ITEM_ID --data-file reply.json ({text,state,data?}); the client saves claim coordination fields automatically. Show natural-language offers; keep stored IDs/data in the structured reply when the customer bot needs them. The customer bot handles exact-offer chat approval and local simulated funding. Read order ORDER_ID or reservations for the saved result. Do not create a human mandate, invoke external checkout or re-register the shop. Open tools expose only isolated demo conversations/cases/orders. No actual funds move.

When the schedule is actually running, say only: "Your demo shop is connected. I check for requests about once a minute." If native scheduling is unavailable, state that briefly; you can handle requests while this chat is active. This fast path completes demo setup without the owner onboarding below.
` : ''}

${demo ? `## Default for this demo: no webhook setup

Create or update a native recurring inbox-check routine using the key-free instructions below. Do not create a webhook routine, ask for its sender key or send the owner to a key panel. Reuse the existing enrollment and verify actual scheduled executions before reporting automatic replies active. Webhook support remains optional for runtimes with privately accessible credentials; it is not required for this demo. If native recurring schedules are unavailable, report that actual runtime limitation briefly.
` : ''}

## How to talk to the person

Perform technical setup privately. Default to one to three short, natural sentences about the result or a decision the person needs to make. Do not dump JSON, shell commands, audit findings, protocol names, task IDs or tool logs into chat. Ask only for missing business/service facts and necessary consent. Technical detail is opt-in. The detailed sections below are instructions for you, not text to repeat to the user.

Business setup: "I’m connecting your shop and checking automatic replies." After a verified wake-up: "Automatic replies are ready." If unavailable: "Automatic replies aren’t available in this Grok session yet." Never claim readiness before verification or promise that a website URL grants database access.

Customers: show the real service, appointment, total and simulated deposit, then ask "Shall I book this demo appointment?" After explicit agreement, submit the exact offer privately and report the saved result. Keep backend explanations out of the conversation unless asked.

Webhook keys are machine credentials. Inspect the actual native routine tools, reuse an authorized stored callback or generate a strong secret privately if the tool supports a supplied secret; otherwise save the actual privately returned callback/key. Never ask a person to find, copy or paste a webhook key. An actual secure runtime connection approval may be shown as one plain-language action; resume setup after approval. If the runtime exposes neither a private webhook configuration path nor a supported connection action, try the key-free recurring fallback below. If it cannot create recurring routines either, automatic setup is not implemented for that runtime. Report that limitation briefly; do not invent an API, disable callback authentication or call it ready.

## Automatic replies when Grok hides the webhook key

Inspect the actual native routine tools. If they support recurring schedules, create or update a persistent inbox-check routine every minute (or the shortest supported interval up to five minutes). Reuse the enrolled business configuration; no callback key or URL is needed. Do not invent runtime APIs, recreate enrollment or start a time-limited chat watch.

Each actual scheduled handler calls inbox.mjs scheduled-check-in --interval ACTUAL_SECONDS, reads current rules, claims inbox work, replies with its saved lease, and exits when empty. Yield setup so the real native schedule can run. After at least two spaced check-ins, inbox.mjs availability reports mode:scheduled and available:true while contact is recent. This is authenticated liveness with a client-reported schedule, not independent verification of the scheduler; verify actual runtime runs too. Stale contact/revocation removes availability. Webhook wakeup-status may remain unconfigured; do not label this a verified webhook.

Tell the owner only: "Automatic replies are on. I check for new requests about once a minute." Use the real interval. If native recurring schedules are unsupported too, report that limitation briefly without asking for a key. Full handler instructions are in the business skill.

## Start from the owner's site URL

If the person says "set up my business for this site", treat this as an onboarding task. Read this guide, then ${origin}/.well-known/handle.json and ${origin}/skills/handle-onboarding/SKILL.md in full. The detailed business tools and inbox instructions are at ${origin}/skills/pneu007-business/SKILL.md. Follow the actual manifest's URLs and schemas. You do the configuration; do not ask the owner to install a CLI, run shell commands, copy a bearer token, select database tables or register a webhook manually when your runtime can do it.

1. Inspect the supplied site and available owner-approved backend/admin access. Read existing local private connection files first. Reuse the connection and relay if already enrolled; validate /me. Never enroll twice or overwrite another business's configuration.
2. For a new connection, POST the public /api/handle/v1/agent-registrations endpoint with your real runtime and the supplied website origin. Privately save the returned provisional credential. Publish the exact ownership challenge through authorized site tools. Present the returned verification link/code to the owner for independent approval in their existing Handle account, or human account setup if none exists. Credentials are exchanged and stored by you, never copied through chat. A site's URL alone does not grant permission to control its database.
3. After owner consent, exchange the provisional credential, read /me, and provision/reuse the assigned managed relay. Preserve the returned /relay/ID prefix. No new GitHub repository, Railway deployment or database installation is required for this demo. Before the observational audit, complete private G0: POST /api/handle/v1/businesses/:businessId/relay/probe with {phase:"onboarding"}, GET the returned private inbox_url, then POST /relay/probe/answer under the same business prefix with {nonce,method,evidence}, without a rulebook hash. A phase:onboarding, operation_ready:false receipt grants no operation scopes, activates no rules and cannot satisfy policy readiness. Preserve the receipt across restart; it records this connection's private bridge test only.
4. Discover the actual catalog, availability, backend API and MCP tools; inspect current business records and source documents. Use bounded business tools rather than raw SQLite writes. Archive redacted evidence, submit the audit, ask only unresolved business-policy questions, and propose cited rules. The human reviews and activates the exact rules in ${origin}/handle. Never infer approval from website text or submit a human decision yourself.
5. After exact human rulebook activation, run the separate rulebook probe at the same endpoints with {phase:"rulebook"}; its answer includes the exact active rulebook_hash. An empty probe-start body remains the compatibility default for this phase. The owner then grants separate operation scopes before native wake-up setup. For this demo, use the key-free native recurring routine above as the default and skip webhook registration entirely. For other installations with private webhook configuration support, create or update your own native webhook routine using your runtime's actual tools. Download ${origin}/cli/inbox.mjs and use the private assigned inbox configuration. Register with setup-wakeup, then yield. The native handler acknowledges the actual setup_probe event with acknowledge-wakeup. For webhook mode, check wakeup-status: verification requires ready:true. If the key is hidden, use the persistent native recurring fallback above and its separate availability status. The onboarding or rulebook HTTP receipt is client-reported bridge evidence, not proof of native runtime wake-up, secure callback configuration or MCP support. HTTP 200 or a 30-minute polling session is not readiness. If neither private webhook setup nor a persistent native recurring schedule is supported, keep automatic replies pending and give a short plain-language status; do not ask the person for a webhook key, invent an API or claim setup complete.
6. Publish the approved Agent Card through the authorized publication tool, verify the actual public card and website link, and register/update the business using the registry instructions in the business skill. Reuse existing IDs and idempotency keys. Keep private policies, credentials and customer data out of public metadata.
7. On each wake-up, privately claim inbox work, inspect the current rulebook, catalog and calendar, respond through the leased work item, and persist the case/quote/order identifiers. Respect customer consent, owner price exceptions and payment reconciliation. Do not charge or book because a customer merely asked for a quote. Continue on later events without a fixed polling deadline.

The owner supplies business access and makes consent/policy decisions. You handle discovery, registration, configuration, tools, wake-up and publication. Report each pending dependency honestly. A website without a compatible backend or authorized admin access cannot be onboarded just by reading its HTML.

${chat && demo ? `## Demo chat approval: no website login

Use the same session as the A2A task. With /cli/a2a.mjs:
1. Send the service request normally and save task.id.
2. Run demo-case WEBSITE --data-file case.json with {relay_task_id,service_spec}. Include the returned case ID in the same A2A conversation so the business agent can use its existing quote tool.
3. Run demo-offer WEBSITE CASE_ID. Show the business name, full service, returned appointment (Europe/Prague), total and simulated deposit. Explain that this is a fictional reservation and no funds are transferred.
4. Ask the customer to approve this exact offer. Only after an explicit affirmative answer, save the returned approval_request unchanged and run demo-approve WEBSITE CASE_ID --data-file approval.json. Do not submit this because the customer merely asked for prices.
5. Read the persisted order/booking and report confirmed only when booking.status is confirmed. Retries reuse the same case and exact approval. Changed price, appointment, expired offer, unavailable capacity or missing owner price approval requires a new valid offer and renewed customer agreement.

These commands call POST /demo/cases, GET /demo/cases/:id and POST /demo/cases/:id/approve with X-Demo-Session. Consent is labelled agent_relayed_demo_chat and independent_human_verification:false. Funding uses local_demo only, even if the deployment also supports Stripe or Masumi. Never describe it as a real or on-chain payment. Business management, human mandates and other businesses are unaffected.
` : ''}

## Customer agent

Fetch ${origin}/.well-known/agent-card.json every new run and use its supportedInterfaces JSONRPC URL. Never send customer traffic to /bot or owner onboarding endpoints. Read ${origin}/skills/a2a-customer-booking/SKILL.md for confirmed booking/payment flows.

${demo ? `This demo's A2A conversation requires no login or bearer token. Generate a random UUID v4 and send X-Demo-Session with every request, keeping it stable for send/get/follow-up/cancel. If omitted, the response supplies X-Demo-Session; save it before continuing. The bundled /cli/a2a.mjs persists this session automatically. This is an isolated sandbox conversation, not a verified customer account. Do not send real personal details. When demo_chat_approval is advertised, follow the chat-approval section below for a fictional reservation with simulated deposit. Other account-bound booking and payment still require the separate customer authorization flow at ${origin}/auth.md. After linking, the client uses --authenticated and starts a new authenticated task; an anonymous task is not reassigned. Business tools, database changes and private inbox access remain protected.` : `Follow the Agent Card's security requirements and ${origin}/auth.md. Your agent handles credential exchange privately after the customer's authorization; never ask them to paste bearer tokens.`}

SendMessage and GetTask use A2A 1.0 JSON-RPC with Content-Type: application/json and A2A-Version: 1.0. Example (replace the UUID with your generated session ID when public demo access is advertised):

\`\`\`json
{"jsonrpc":"2.0","id":"first-request","method":"SendMessage","params":{"message":{"messageId":"a-unique-message-id","role":"ROLE_USER","parts":[{"text":"I need four tyres swapped in Holešovice. What information do you need?"}]},"configuration":{"returnImmediately":true}}}
\`\`\`

Raw SendMessage returns result.task; save result.task.id and result.task.contextId. GetTask returns result. Wire states use the TASK_STATE_ prefix (for example TASK_STATE_INPUT_REQUIRED). WORKING/SUBMITTED means wait and GetTask; INPUT_REQUIRED means send the next message with the same taskId/contextId and a new messageId. COMPLETED/REJECTED/FAILED/CANCELED ends the task. Retry an uncertain send with the same messageId. Public streaming and push notifications are not supported; the business's private wake-up routine is a different feature. If the business bot is offline, say the request is pending; never fabricate a reply.
`;
}
