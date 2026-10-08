<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT. THIS IS COMPLEMENTARY TO OMX TEAM MODE.
<!-- END AUTONOMY DIRECTIVE -->

# Shared project specification

Before working on Handle, read [docs/scope-of-work.md](docs/scope-of-work.md).
It is the shared **Final Draft v2.2**, updated on 9 October 2026, and the
canonical product and technical specification for this repository.

Use that specification to align implementation, prompts, diagrams, and tests.
New explicit user instructions take precedence. If a later decision changes the
process, update the canonical specification and affected acceptance criteria;
do not create a competing specification. Treat draft requirements separately
from features proven by code or runtime evidence.

Core requirements to preserve:

- Handle and its relay engine are hosted by the development team. A fresh
  business agent registers, obtains verified human owner consent, and provisions
  its firm's managed relay through the supported API.
- The agent audits existing websites/admin UIs, documented APIs and existing MCP
  tools using owner-provided access. No bespoke audit connector is required.
  Store a cited report/evidence; an independently authenticated Handle human
  activates an exact rulebook version. Legacy admin access given to the bot does
  not confer human Handle approval. No finished audit or active rules are seeded.
- Pneu transactional operations use a separate owner-created or owner-approved
  agent service account and a thin MCP over the same policy-checked backend APIs.
  MCP is a tool interface; backend rulebook/mandate/approval checks still apply.
  Verify actual runtime MCP support and keep the same HTTP business path.
- After approval, the agent uses a separate limited website publication grant
  to publish the Agent Card and visible link on the business website. Customer
  agents discover the current endpoint from that card.
- Firm identity and context survive runtime replacement. Each connection has
  separate credentials, scopes, and revocation. Owner-approved handover preserves
  cases and valid approvals and prevents duplicate orders or payments.
- Legacy systems and the payment provider remain authoritative for their own
  records. Masumi Preprod evidence is distinct from local simulation.
- State enforcement guarantees per operation. A full external admin/browser
  account can bypass Handle controls; revoking Handle access does not revoke
  independent legacy sessions. Verify native revocation and uncertain writes
  before claiming exclusive handover or retrying an external commitment.

The HTML implementation plan is a subordinate execution aid, not a replacement
for the shared specification. Preserve concurrent work by other agents and keep
changes within the authorized task.

## Working agreements

- Keep changes small and reversible; reuse existing modules and utilities.
- Add no dependencies without an explicit user request.
- Keep credentials, private keys, local databases and runtime state out of Git.
- Verify changes with appropriate tests and checks before reporting completion.
- Write implementation plans in HTML. Maintain the canonical specification in
  its established Markdown format.
- Commit messages follow the Lore protocol: explain the intent first, then
  context and useful native trailers such as Tested, Confidence and Scope-risk.
