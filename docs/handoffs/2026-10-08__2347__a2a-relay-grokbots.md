# Handoff: A2A relay + Grok Bot ↔ Grok Bot (Polar Scoop test)

**Goal:** two real Grok Bots (Customer, Business) talk over A2A v1.0 through our relay, with the customer discovering the business from its website and the business bot woken automatically.

**Status: ~85% of G0.** "Done" for G0 means all of the following:
- (a) Grok ↔ Grok with no human relaying: ✅
- (b) unattended wake-up: ✅
- (c) discovery from the website: ✅ (bot self-report only)
- (d) separate accounts confirmed: ❓
- (e) A2A TCK conformance: ❌
- (f) server-side discovery evidence: ❌

The Pneu 007 business logic (rulebook, quotes, booking) is out of this thread's scope; teammates are building it.

## DONE (verified)

**Relay** (`apps/relay`): A2A v1.0 JSON-RPC (`@a2a-js/sdk` 1.3.0) + SQLite.
- **Turn handling:** blocking send held until the Business reply; turn guard; dedupe by `messageId`; max 10 Business replies per task; owner-scoped tasks.
- **Private inbox** (`/bot/*`, not A2A); restart-safe stored-reply path.
- **Doorbell:**
  - env, or self-registered via `inbox set-doorbell`;
  - allowlist `api2.cursor.sh`;
  - re-rings unanswered items every 60 s;
  - the key is never shown or logged.
- **Enrollment:** one-time codes (`POST /admin/enrollments` → `POST /enroll/:code`).
- **Public pages:**
  - business profiles in `apps/relay/profiles/{pneu007,icecream}.json`;
  - website at `/` with a "For AI agents" box, `<link rel="agent-card">`, a `Link` header, and `/llms.txt`;
  - card served via `AgentCard.toJSON`, because the SDK's `agentCardHandler` leaks `$case`.
- **Evidence:** `npm test -w @pneu007/relay` → **13/13 pass** (run 2026-10-08 23:47).

**CLIs** (`packages/agent-client`), bundled to `dist/{a2a,inbox}.mjs` and served at `/cli/*.mjs`:
- `a2a`: discover (well-known, then page link fallback; prints `found via`), send/get/wait/cancel, login/enroll.
- `inbox`: enroll, read/wait/watch, reply, show, set-doorbell/clear-doorbell.

**Live on Railway:** project `pneu007-relay`, https://relay-production-9e34.up.railway.app.
- `/healthz` returns 200.
- `BUSINESS_PROFILE=icecream`.
- The doorbell is registered by the bot for routine `/automations/webhook/da94012c-a1f7-5203-aad1-c5ab8445375e`.

**Runs** (all in `docs/runtime-proof.md` with message IDs):
- **Run 1:** Grok ↔ Grok, Business kept awake with `watch`. Order PS-0001, 110 CZK.
- **Run 2:** script customer, Business woken by the doorbell. Ring to reply 15–18 s.
- **Run 3:** Grok ↔ Grok + doorbell. No mango (refused correctly); budget fallback to 3 scoops; PS-0002, 165 CZK; 28 s total; task `81bf9c1b-c778-4124-85f0-bfdd70c0153e`.

**Other:**
- The OpenClaw `icecream` agent (created by mistake) was deleted; files went to the Trash; `main`/`chaty` bindings unchanged.
- Memory saved: Business Grok Bot paste messages also go to Apple Notes (see Landmines).

## IN FLIGHT (uncommitted, mine)
- `docs/runtime-proof.md`: Runs 2 and 3 appended (+67 lines). Not committed.
- `prompts/grokbot-customer-test2.md`: untracked.
- `docs/handoffs/2026-10-08__2347__a2a-relay-grokbots.md`: this file, untracked.
- **Apple Notes save failed** (AppleEvent timeout −1712). A macOS Automation dialog for controlling Notes is pending on the Mac mini's screen. Nothing was saved. Re-run after the user clicks Allow:
  `python3 scripts/grokbot-note.py prompts/grokbot-business-doorbell.md "Polar Scoop – automatic wake-up (paste next)"`

Dirty files that are **not mine** (teammates): `docs/masumi-setup.html`, `infra/masumi/*`, `docs/diagrams/handoru-pitch-workflow.*`, `tasks/masumi-e2e.html`. Don't commit or revert them.

## NOT STARTED / BLOCKED
- **Discovery event logging:** log hits on `GET /` and the card, so the timeline shows page → card → first message (T04 evidence). Offered to the user; no answer yet.
- **Separate-accounts proof:** blocked on the user confirming which Grok Bot account each bot used. The relay only sees tokens.
- **A2A TCK:** needs a scripted responder keyed on `messageId` prefixes plus a no-auth test mode. Not built.
- **Concurrency:** two customers at once, and a ring arriving while a routine run is busy. Untested; Grok webhook calls aren't queued.
- **Python CLI fallback:** only needed if a Grok VM lacks Node. Both VMs had Node.

## Repo facts
- Git repo `origin https://github.com/zabrodsk/a2a-business-platform.git`, branch `main`, last commit `ab79582`.
- The relay and CLI code are already committed (by teammates; e.g. `b38c70d`).
- Teammates added `apps/registry`, `apps/legacy`, `packages/{audit,contracts,demo-garage,payments}`, `infra/masumi`, and a `garage` CLI in `packages/agent-client/build.ts`.
- Root `npm test` runs every workspace (132 tests passed at 22:4x).
- Railway service variables: `ADMIN_TOKEN, BUSINESS_PROFILE, BUSINESS_TOKEN, CUSTOMER_TOKENS, PUBLIC_URL`. Secrets also live in `.env.railway` (mode 600, gitignored). Never print them.

## Landmines
- **Deploys:** commit `0565cdc` mentions automatic Railway deployment. A `railway up` and a GitHub auto-deploy can overwrite each other. Check `railway status` and the build source before deploying. Always ask the user before any deploy.
- **The relay is now the ice cream shop.** Switching back with `railway variable set BUSINESS_PROFILE=pneu007` changes the live card and website for the teammates' Pneu 007 demo too.
- **Lockfile:** if `package-lock.json` drifts from new workspaces, Docker `npm ci` fails. Check with `npm ci --dry-run` before deploying; fix with a root `npm install`.
- **This Mac mini is PRODUCTION.** `~/.openclaw/**` is protected, and "Clawdbot" is OpenClaw. Use the Grok Bot desktop app 0.68.1, which hides routine webhook URL and key; workaround: click the routine chip.
- **I can't type into Grok Bot.** The user pastes prompts. Business-bot prompts must also go to Apple Notes via `scripts/grokbot-note.py` (user preference, in memory).
- **Enrollment codes:** single-use; redeeming with the wrong CLI burns them. A backup customer code (`…/enroll/bDxKNuCf2fYjzy_V`) expires 2026-10-09 00:29 and is unused.
- **Timestamps:** the relay event log is in UTC; Prague is +2.

## NEXT-SESSION PROMPT

```text
Read docs/handoffs/2026-10-08__2347__a2a-relay-grokbots.md first, then docs/runtime-proof.md and docs/g0-runbook.md. Context: hackathon repo /Users/clawdbot/hackathon001 on the PRODUCTION Mac mini. An A2A v1.0 relay (apps/relay) runs on Railway (https://relay-production-9e34.up.railway.app, profile "icecream" = fictional Polar Scoop shop). Two real Grok Bots have completed orders through it (Runs 1–3), and the Business bot wakes via a self-registered webhook routine.

Do, in order:
1. Verify the state: `npm test -w @pneu007/relay` (expect 13/13), `curl …/healthz`, `git status` (some dirty files are teammates' — leave them).
2. Ask me whether to commit my uncommitted files (docs/runtime-proof.md, prompts/grokbot-customer-test2.md, this handoff). Commit only those, with the repo's message style.
3. If I've clicked Allow on the macOS Notes dialog, re-run scripts/grokbot-note.py for prompts/grokbot-business-doorbell.md and read the note back.
4. Offer the next items, in priority order: discovery event logging (page/card hits in /admin/events), concurrency test (two customers at once), A2A TCK run.

Rules: never print tokens or keys (.env.railway); ask before any Railway deploy or variable change (check whether GitHub auto-deploy is active first); I paste all Grok Bot prompts myself, so give them to me ready to paste, and save Business-bot ones to Apple Notes too.
```
