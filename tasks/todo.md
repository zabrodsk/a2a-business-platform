# G0 relay + CLIs (Person B)

Spec: `docs/agent-comms-plan.md` §3–§5. Hosting chosen: Railway, live at https://relay-production-9e34.up.railway.app (see `docs/hosting.md`; redeploy with `railway up --detach`).

## Plan
- [x] Scaffold npm workspace: `apps/relay` (server), `packages/agent-client` (CLIs)
- [x] Relay: A2A v1.0 JSON-RPC via `@a2a-js/sdk` 1.3.0, SQLite (`better-sqlite3` + Kysely) task store, Agent Card at `/.well-known/agent-card.json`
- [x] Relay: bearer auth (tokens from env), sender derived from token, tasks owner-scoped
- [x] Relay: executor holds the A2A task in WORKING until Business replies → INPUT_REQUIRED / COMPLETED / REJECTED
- [x] Relay: turn guard (no customer message during Business's turn), max 10 business messages per task
- [x] Relay: private `/bot/inbox`, `/bot/wait`, `/bot/reply` (NOT A2A), idempotent reply, restart-safe fallback
- [x] Relay: webhook doorbell to Business routine + re-ring; event log `/admin/events`
- [x] CLI `a2a` (customer, generic A2A client via SDK): discover, send, get, wait; token only sent to its configured origin
- [x] CLI `inbox` (business): read, wait, reply
- [x] Bundle both CLIs to single files, served at `/cli/*.mjs`
- [x] Verify: typecheck, automated end-to-end test (scripted customer + scripted business), restart test
- [ ] A2A TCK run (needs a scripted TCK responder + no-auth test mode): deferred

## Review
- Built `apps/relay` (Express + `@a2a-js/sdk` 1.3.0 + SQLite) and `packages/agent-client` (`a2a`, `inbox` CLIs bundled to single `.mjs` files).
- `npm test`: 9/9 end-to-end tests pass on two consecutive runs. Real HTTP; the bundled CLIs run as subprocesses; scripted bots.
- Manual checks:
  - killed and restarted the relay mid-conversation: the reply was delivered via the stored path;
  - raw `curl` JSON-RPC exchange is spec-shaped;
  - card is ProtoJSON.
- Found an SDK issue: `agentCardHandler` serializes the internal object and leaks `$case` for `securitySchemes`. Worked around by serving `AgentCard.toJSON(card)`.
- Not done:
  - deployment (host undecided);
  - real GrokBot accounts (G0.4–G0.6);
  - A2A TCK;
  - a way to deliver tokens without pasting them in chat;
  - a Python CLI fallback.
