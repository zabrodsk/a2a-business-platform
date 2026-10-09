# Agent-to-agent communication plan (G0 → full demo)

Status: proposal, 2026-10-08. Owner: Person B (per scope-of-work §11).
Inputs: `docs/scope-of-work.md` v2.0 (§3 G0, §6 discovery, §7 bridge), A2A spec v1.0.1
(github.com/a2aproject/A2A @ 12e9d2f, 2026-10-07), Grok Bot docs research (§7).

## 1. What the scope already decides

- Two real GrokBots on separate accounts: `Customer` (account A) and `Business` (account B).
- No human copy-pasting messages. Pre-started polling sessions are acceptable but must be labelled.
- Customer only knows company name, address, website URL. It discovers the endpoint live
  from `/.well-known/agent-card.json`.
- The public side must be genuinely A2A-compatible. Our private inbox behind it is not A2A
  and must not be called A2A.
- TypeScript + SQLite on a persistent disk, one server.
- First goal (G0): request → reply between the two accounts, no garage logic yet.

## 2. What A2A gives us (and what it doesn't)

A2A v1.0 (released 2026-03-12, patch 1.0.1 2026-05-26) is a client → server protocol:
the agent being talked to is an HTTP server that publishes an Agent Card. Relevant pieces:

| A2A feature | Use in our build |
| - | - |
| Agent Card at `/.well-known/agent-card.json`, `supportedInterfaces[]` with url + binding + `protocolVersion: "1.0"` | Exactly the discovery the SOW wants (§6.2). Changing the URL in the card = test T15. |
| `SendMessage` returns a `Task` (id, contextId, status, history, artifacts) | One A2A task = one Pneu 007 case (`task_id`). |
| Blocking send (default `returnImmediately: false`) waits until the task is terminal **or `INPUT_REQUIRED`** | Customer's `send` call simply blocks until the Business bot has answered. Customer side needs no wake-up for normal turns. |
| `TASK_STATE_INPUT_REQUIRED` | "Your turn, customer." Natural turn token for negotiation. |
| Follow-up `SendMessage` with same `taskId` | Next negotiation turn in the same case. |
| `GetTask` polling, push notifications (webhook POST with `Authorization: <scheme> <credentials>`) | For long waits (owner approval). Push maps onto a Grok webhook routine if that works. |
| `DataPart` (structured JSON part) alongside `TextPart` | Carry the SOW §7.4 envelope payload (`quote_id`, `proposed_total_minor`, ...) as validated data, free text stays text. |
| Artifacts on completion | Booking result (`booking_id`, `payment_id`, amounts). |
| `securitySchemes` (HTTP bearer) | Per-identity demo tokens; server derives sender from token (SOW §7.4). |

What A2A does **not** give us:

- A way for a GrokBot to *be* an A2A server. Neither bot hosts HTTP. So the Business
  bot sits *behind* our relay: the relay is the A2A server, and its executor hands work to
  the real Business GrokBot through a private inbox. This is the SOW §7.1 "Handle" design.
- Wake-up of a chat agent. That is a Grok Bot runtime question (§7).
- Turn limits, owner approval, mandates — those stay in our backend.

Libraries (checked today):

- `@a2a-js/sdk` 1.3.0 (npm, 2026-09-29) implements spec v1.0: Express JSON-RPC + REST
  handlers, `AgentExecutor`, push-notification sender, and a Kysely `DatabaseTaskStore`
  that supports **SQLite**. Matches our TS + SQLite stack; use it for both server and client.
- `a2a-sdk` 1.2.2 (PyPI) if the bot sandbox only has Python.
- `a2a-tck` (conformance suite, JSON-RPC/REST/gRPC) → our evidence for T22.
- `a2a-inspector` (web UI, card validation, raw JSON-RPC log) → debugging + a nice demo shot.

## 3. Architecture

```text
 Account A                          our server (one host, HTTPS)                     Account B
┌───────────────┐   A2A v1.0     ┌──────────────────────────────────────┐   private   ┌───────────────┐
│ Customer      │  JSON-RPC      │ /.well-known/agent-card.json         │   inbox     │ Business      │
│ GrokBot       │──────────────▶ │ /a2a  (a2a-js DefaultRequestHandler) │◀───────────▶│ GrokBot       │
│  + a2a CLI    │  bearer tok A  │   AgentExecutor ──▶ work_items (SQL) │ bearer tok B│  + inbox CLI  │
│  (generic     │◀── blocks until│   task store (SQLite)                │             │               │
│   A2A client) │  INPUT_REQUIRED│ /bot/inbox, /bot/reply  (NOT A2A)    │──wake──────▶│ (webhook /    │
└───────────────┘                │ /events (console timeline)           │             │  poll loop)   │
                                 └──────────────────────────────────────┘             └───────────────┘
```

- **Customer → server:** genuine A2A, via a generic CLI that knows nothing about Pneu 007.
- **Server → Business bot:** our private API (`inbox read`, `inbox reply`). Labelled as such.
- **Bridge never writes text for either bot.** It stores, routes, enforces turn/limit rules.

### Turn protocol (G0)

1. Customer: `a2a discover https://pneu007.example` → prints card, chosen interface, auth.
2. Customer: `a2a send "<text>"` → server creates task (`SUBMITTED` → `WORKING`), inserts a
   work item for Business, triggers wake-up, and holds the HTTP call (blocking send).
3. Business: `inbox read` → gets task id, context, history. `inbox reply <task> "<text>"
   [--data file.json] [--state input-required|completed|rejected]`.
4. Server publishes status-update with Business's message → task `INPUT_REQUIRED` →
   Customer's blocked `send` returns with the reply.
5. Customer: `a2a send --task <id> "<text>"` for the next turn, until `COMPLETED`/`REJECTED`.

Guardrails in the relay (SOW §7.4): server-derived sender, idempotent `messageId`,
max 10 business messages per task then `FAILED` + escalation, one active work item per task.

Blocking-call timeout: if the Business reply takes longer than the HTTP budget (start with
120 s), the server returns the task in `WORKING`; the CLI then falls back to `a2a wait <task>`
(polls `GetTask`). The CLI does this automatically, so the bot sees one command.

### State mapping (for later phases)

| SOW state | A2A `TaskState` | Extra |
| - | - | - |
| requested | SUBMITTED | |
| negotiating (business's turn) | WORKING | |
| negotiating / offered (customer's turn) | INPUT_REQUIRED | offer in DataPart |
| waiting_owner | WORKING | `metadata.pneu007.state = "waiting_owner"`; customer gets `returnImmediately` + push/poll |
| waiting_customer | INPUT_REQUIRED | `metadata.pneu007.state = "waiting_customer"` (needs human) |
| accepted | WORKING | |
| committed | COMPLETED | booking artifact |
| rejected | REJECTED | |
| expired / failed | FAILED | reason in status message |
| cancelled | CANCELED | |

Business sub-states live in `metadata`; we only declare what we implement in the card.

## 4. G0 build plan (timebox ≈ 45 min, Person B)

| Step | Deliverable | Done when |
| - | - | - |
| G0.1 | Server skeleton: a2a-js Express, JSON-RPC binding only, SQLite task store, static Agent Card (`capabilities.streaming=false`, `pushNotifications=false` at first), bearer auth with two demo tokens, `/bot/inbox` + `/bot/reply`. Deployed on public HTTPS with persistent disk. | `curl` of the card works from outside; a2a-inspector connects. |
| G0.2 | `a2a` CLI (single file, Node ≥18 or Python): `discover`, `send [--task]`, `get`, `wait`. Token read from env/file, never echoed. | Laptop run: send → (manual `curl /bot/reply`) → send returns reply. |
| G0.3 | `inbox` CLI for Business: `read`, `reply`. | Laptop run of both CLIs completes 3 turns. |
| G0.4 | Run the §7 real-account checklist first. Install CLIs in both GrokBot computers; give each its token through the safest channel the runtime offers (§7). | Each bot can run `--help` and an authenticated no-op. |
| G0.5 | **Manual-nudge run:** human tells Customer "ask Pneu 007 X"; human tells Business "check your inbox". Bots run the commands themselves. | Message ids + timestamps in `docs/runtime-proof.md`. No text copied by humans. |
| G0.6 | **Autonomous run:** Business is woken without a human (webhook routine, or pre-started polling session); Customer's blocking `send` carries it through 3+ turns. | 3 turns, zero human input after the first prompt; latency per turn recorded. |
| G0.7 | Conformance: run `a2a-tck --transport jsonrpc` against the server; record pass/fail and declared-but-unsupported features. | Report saved; card declares only what passed (T22). |

Then move on to discovery tests T04/T15/T16 (change endpoint in card, missing card, wrong version).

## 5. Wake-up options for the Business bot (pick in G0.6)

1. **Webhook routine** (preferred by SOW §2). On new work item, server POSTs to the
   Business bot's routine URL with its key. Routine prompt: "run `inbox read`, handle all
   pending items, reply, exit." Also reusable for Customer as the A2A push-notification
   target during owner-approval waits.
2. **Pre-started polling session** (fallback). Business bot runs `inbox wait --timeout N`
   in a loop inside one long session. Must be labelled "pre-started agent session".
3. **Scheduled routine** — minimum 5-min interval (documented), so only a safety sweep, never the main path.
4. **Not used:** undocumented VM gateway `:1340/api/sendPrompt`, same-account native Bot messaging.

## 6. Risks and how G0 de-risks them

| Risk | Mitigation |
| - | - |
| Bot can't run outbound HTTPS or install a CLI | G0.4 is the first thing tested on real accounts; MCP connector is the alternative (§7). |
| Blocking HTTP call times out inside the bot's tool runner | CLI auto-falls back to `wait` polling; tune budget from observed limits. |
| Webhook routine output doesn't reach the customer's visible conversation | Only Business needs the wake-up; Customer stays in its own live session. |
| Secrets leak into chat | Tokens via env/file, CLI never prints them; rotate after the event. |
| Calling relay-to-relay "A2A" | The A2A client runs in the Customer bot's computer, not on our server. If Customer only reaches us via an MCP connector hosted on our server, the A2A hop must still originate from a customer-side component — otherwise it is not an A2A demo. |
| Dev blocked on GrokBot access | Develop against the CLIs with a scripted fake bot or the local Hermes `grok` profile (xAI API). **Not** the demo; SOW §3 forbids presenting API-model runs as GrokBot-to-GrokBot. |

## 7. Grok Bot runtime facts (desk research 2026-10-08, not yet tested on our accounts)

Grok Bot is hosted by Cursor/Anysphere: each **account** gets one persistent microVM, and all
Bots on that account **share it** (files, CLI credentials). Sources: docs.x.ai/grok-bot/*,
cursor.com/help/grok-bot/routines, forum.cursor.com threads 168199, 171324, 173891.

| Question | Finding | Confidence | Consequence for us |
| - | - | - | - |
| Outbound HTTP from the VM | Browser + command line + files. Egress is allow-all on Personal/Teams plans; only Enterprise has allowlists. Traffic comes from shared datacenter IPs. | Documented | The CLI approach works in principle. Don't block datacenter IPs on our relay. |
| Installed runtimes (node/python/curl) | Not listed. Packages you install are wiped on Reset. | Unknown | Serve the CLI from our server (`GET /cli/a2a.mjs`) so a bot can reinstall it with one command. Check `node -v` / `python3 -V` first in G0.4. |
| Inbound HTTP / public port | Not documented. Treat the VM as outbound-only. | Documented by absence | Confirms the relay design. Neither bot can be an A2A server. |
| Webhook routine | Ask the Bot to add a webhook trigger to a routine. Fire it with `POST <url>` + `Authorization: Bearer <crsr_… key>` + optional JSON body. The Bot receives the body together with the routine's instruction, and output posts to the conversation that owns the routine. 200 = a run started; there is no queue. | Documented (Cursor help) + reported | Works as a doorbell. Fits **A2A push notifications** directly: `authentication: {scheme: "Bearer", credentials: <key>}` makes our server POST the exact header Grok expects. |
| Webhook bug | On desktop 0.47–0.68.1 the routine URL/key often isn't shown. Workaround: click the routine chip in the chat, or ask the Bot for the link. | Reported, current | Get both webhook URLs **first thing**, on every teammate's app version. |
| Scheduled routines | Must be at least **5 min** apart. Unattended routines pause after a long absence. | Documented | Too slow for negotiation. Use only as a safety sweep. |
| Approvals during unattended runs | Expire after about 10 min. If an admin enforces Auto Review, shell commands may need approval. | Documented | Turn Auto Review off on the demo accounts, or pre-approve the CLI. A pending approval would stall the webhook path silently. |
| Custom remote MCP | No settings field. Ask in chat: "add a custom MCP server X at https://…" and supply an OAuth card or a header key. Account-wide. Localhost URLs fail. | Reported (third party) | Good fit for **Business's private tools** (inbox, garage). It's a vertical integration, so it's honest to host on our server. |
| Skills | Created by asking the Bot to save a process as a skill, or written. Shared library per account. Raw SKILL.md upload is not documented. | Documented / unknown | Save "how to use the a2a CLI" as a generic skill on the Customer account. |
| Programmatic message into a chat | No public API. The undocumented VM gateway `127.0.0.1:1340 /api/sendPrompt` needs ssh or Tailscale into the VM. | Reported, unsupported | Don't build on it. Emergency fallback only, and label it. |
| Time limit per turn | Not documented. A cap is hinted at; usage is metered weekly. | Unknown | Keep blocking calls ≤ 120 s, with auto-fallback to polling. Measure in G0.6. |
| Bot-to-bot | Native messaging works only between Bots on the **same account**. Nothing about other accounts or A2A. | Documented | Native handoff is not our demo. The cross-account A2A relay is the novel part. |

### Decisions this drives

1. **Separate accounts are mandatory**, not just preferred. Bots on one account share a VM and
   credentials. An owner bot on the Business account shares the Business VM, so record that
   in `limitations.md` (SOW §7.6, T20).
2. **Wake-up = webhook doorbell + inbox drain.** The relay POSTs a tiny body (`{"pending": n}`,
   no secrets, no customer text). The routine instruction reads: "run `inbox read`, handle every
   pending item, reply, stop." Calls aren't queued, so the relay re-rings when an item stays
   unclaimed for 60 s. Handling is idempotent per work item.
3. **Customer side:** blocking `SendMessage` for normal turns, so no wake-up is needed. For the
   owner-approval wait, the CLI sends `returnImmediately: true` plus a `taskPushNotificationConfig`
   that points at the **Customer's own webhook routine**. That is a spec-conformant A2A push
   straight into a real GrokBot. If the webhook path fails, fall back to `a2a wait` polling.
4. **Business tools:** remote MCP connector on our server if "add custom MCP" works in G0.4.
   Otherwise use the same tools as an `inbox`/`garage` CLI. The business contract stays the same
   either way (SOW §7.2).
5. **Customer's A2A client always runs in the Customer VM** (CLI). It must never be an MCP
   tool hosted on our server, because that would make the A2A hop server-to-itself.

### G0 checklist on real accounts (do before writing app code)

- [ ] Both accounts: `node -v`, `python3 -V`, `curl -I https://<relay>/.well-known/agent-card.json`.
- [ ] Business: create a routine with a webhook trigger, retrieve the URL and key (chip-click workaround),
      fire it with `curl` from a laptop, confirm the run and where the output shows up.
- [ ] Same on Customer (needed for push during the owner wait).
- [ ] Business: try "add custom MCP server" with a header key against a stub endpoint.
- [ ] Measure: how long a single `sleep 90 && echo ok` / blocking curl is allowed to run.
- [ ] Check Auto Review / approval settings on both accounts.

## 8. Open questions for the team

- ~~Hosting for the relay~~ → Railway test environment, see `docs/hosting.md`.
- Which account owns Customer vs Business; is a third account available for the owner bot?
- Who holds the demo tokens and how they are placed in each bot's environment.
