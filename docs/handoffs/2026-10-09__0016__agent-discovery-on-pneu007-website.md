# Handoff: "For AI agents" discovery on the Pneu 007 website

**Goal:** when any AI agent visits the Pneu 007 website, it immediately learns that Pneu 007 has its own agent, and that it should **talk to that agent** (via A2A) instead of scraping pages or filling in the human order form.

**Status: ~50%.** Built and tested on the relay's own site, where the ice cream test ran. Not yet applied to the real Pneu 007 site (`apps/legacy/public/*.html`). "Done" means:
- every public Pneu 007 page carries the signals below;
- the homepage shows a visible agent box, not just a "Pro agenty" link;
- `a2a discover https://pneu007-production.up.railway.app/<any page>` succeeds;
- a legacy test asserts all of the above.

Who does what: the person now working on `apps/legacy` should implement the steps under NOT STARTED below. The pattern already exists; this file says where.

## DONE (implemented and verified)

All of this lives in the **relay** code and is committed in `b38c70d` ("Allow agents to discover and contact a business with isolated identities").

1. **Reference implementation:** `apps/relay/src/site.ts`. It uses four layers, strongest first:
   - **A2A standard (the only official one):** the card at `/.well-known/agent-card.json` on the website's own origin. `GET https://pneu007-production.up.railway.app/.well-known/agent-card.json` returns 200 (checked 2026-10-09 ~00:10): "Pneu 007 service agent", endpoint `…/a2a/jsonrpc`, JSONRPC, A2A 1.0.
   - **Visible box on the page:** `renderHomePage()` → `<section id="ai-agents">` "For AI agents: talk to our agent", listing protocol, Agent Card URL, endpoint, access, skill and client link. Browsing agents such as Grok Bot read the page, not headers, so this is the layer that matters most for them.
   - **Machine hints (conventions, NOT A2A standard):**
     - `<link rel="agent-card" type="application/json" href="…/.well-known/agent-card.json">` in `<head>`;
     - HTTP header `Link: <…/.well-known/agent-card.json>; rel="agent-card"; type="application/json"`, from `agentLinks()`.
   - **`/llms.txt`:** `renderLlmsTxt()`. Already live on Pneu 007 (200). It's served by the embedded relay from `apps/relay/profiles/pneu007.json` → `site`.
2. **Client side:** `packages/agent-client/src/a2a-cli.ts`.
   - `discover()` tries the well-known URI first, then `cardLinkFromPage()` (the `Link` header, then `<link rel="agent-card">` in the HTML).
   - It prints `found via:` and fails explicitly if nothing is found; it never guesses an endpoint.
3. **Tests:** `apps/relay/test/e2e.test.ts`:
   - "website: visiting agents find the shop agent from the page itself";
   - "website hosted elsewhere: discover follows `<link rel="agent-card">` or the Link header" (covers html-link, header-link and no-link pages).
   - Relay suite: **13/13 pass** (2026-10-08 23:47).
4. **Proven with a real Grok Bot** (ice cream test, Run 3 in `docs/runtime-proof.md`). The customer bot reported it fetched the homepage, saw the "For AI agents" section, also checked the well-known card, and found both pointed to the same card. That's the bot's own report; there's no server log of it.

## IN FLIGHT
- **Another session is actively editing** `apps/legacy/*`, `apps/relay/src/{auth,bot-api,config,executor,site}.ts`, `packages/agent-client/src/inbox-cli.ts`, `packages/{contracts,payments}` and a new `apps/legacy/src/agent-auth.ts`. Its work-in-progress includes:
  - agent credentials shared by the business tools and A2A (`cfg.lookupAgentToken`);
  - an OAuth-style `WWW-Authenticate: Bearer resource_metadata=…`;
  - `site.ts` / `llms.txt` now point to `${publicUrl}/auth.md` for registration when `authResourceMetadataUrl` is set (`docs/auth.html` is new).

  **Do not edit those files until that session commits.** The user said "wait for it".
- Mine, uncommitted (the user said don't commit yet):
  - `docs/runtime-proof.md` (Runs 2 and 3);
  - `prompts/grokbot-customer-test2.md`;
  - `docs/handoffs/` (this file and `2026-10-08__2347__a2a-relay-grokbots.md`).

## NOT STARTED: what to implement on the Pneu 007 website (`apps/legacy`)

Current gap: `grep -c 'rel="agent-card"' apps/legacy/public/*.html` → 0 in all 7 pages. `index.html` only has a "Pro agenty" link (around line 939, `href="/pro-agenty"`). The legacy server sends no `Link` header. Note: in the unified system, `legacy.app` serves `/` (`index.html`); the relay's own `/` page is never reached there.

1. **`<head>` of every public page** (`index, kalkulator, kontakt, objednavka, podminky, pro-agenty`; not the internal `console.html`):
   ```html
   <link rel="agent-card" type="application/json" href="/.well-known/agent-card.json">
   <link rel="alternate" type="application/json" href="/.well-known/agent-card.json" title="A2A Agent Card">
   <link rel="alternate" type="text/markdown" href="/llms.txt" title="llms.txt">
   ```
2. **The `Link` header on HTML responses** in `apps/legacy/src/server.ts`, added before the static middleware. Same string as `agentLinks(cfg).linkHeader` in `apps/relay/src/site.ts`:
   `Link: <https://pneu007-production.up.railway.app/.well-known/agent-card.json>; rel="agent-card"; type="application/json"`
   Build it from `LEGACY_PUBLIC_URL`; don't hard-code the host.
3. **A visible agent box on the homepage itself**, near the top, not only behind `/pro-agenty`. Bilingual, so both Czech and English agents get it. Suggested copy:
   > **Pro AI agenty / For AI agents.** Jednáte za zákazníka? Nevyplňujte webový formulář — domluvte se přímo s agentem Pneu 007 (kalkulace, nabídka, termín, testovací platba).
   > *Acting for a customer? Don't fill in the web form or scrape these pages. Talk directly to the Pneu 007 agent (price, quote, slot, test payment).*
   > Protocol: A2A v1.0 (JSON-RPC) · Agent Card: `/.well-known/agent-card.json` · Access: Bearer token (see `/auth.md` / `/pro-agenty`) · Generic client: `/cli/a2a.mjs`

   Reuse the markup and wording of `renderHomePage()` → `#ai-agents`. Keep `pro-agenty.html` as the detailed page and link to it from the box.
4. **Optional:** add one sentence to the `<meta name="description">`: "AI agents: talk to our agent via A2A, Agent Card at …" (also in `renderHomePage()`).
5. **Align `apps/relay/profiles/pneu007.json` → `site`** with the real site. It feeds `/llms.txt` on Pneu 007, and its phone `+1 (202) 555-0170` / tagline were placeholders I wrote. `kontakt.html` shows `[PLACEHOLDER: telefon]`. Use one fictional number in both.
6. **Add a legacy test** mirroring the relay ones: `GET /` has the `Link` header, the `<link rel="agent-card">` and the visible box; every public page has the `<link>`; the `a2a discover` CLI against a running legacy system prints `found via: well-known URI`.
7. **Verify live after deploy:**
   ```bash
   node packages/agent-client/dist/a2a.mjs discover https://pneu007-production.up.railway.app/kalkulator
   curl -sI https://pneu007-production.up.railway.app/ | grep -i '^link'
   ```

Also pending (separate from the website work):
- Remove all ice cream content: `apps/relay/profiles/icecream.json`, `fixtures/icecream/`, `prompts/grokbot-*icecream*.md`, `prompts/grokbot-business-doorbell.md` (ice cream specific), `prompts/grokbot-customer-test2.md`, and the ice cream sections in `docs/g0-runbook.md`. Keep the history in `runtime-proof.md`. Blocked by "wait for other session" + "don't commit".
- Move both Grok Bots from the old relay to Pneu 007. Prompts not drafted yet; they depend on the other session's shared-login design. Pneu 007 has enrollment codes **disabled** (`/enroll` → 404 `ENROLLMENT_DISABLED`), so logins go in via Grok Bot's masked "Save securely" field.
- Old ice cream Railway project `pneu007-relay` (relay-production-9e34): delete after the bots move. Ask the user first; it's irreversible.

## Repo facts
- Repo `github.com/zabrodsk/a2a-business-platform`, branch `main`, HEAD `300bbff` (= origin/main at 00:10).
- Many dirty files, mostly the other session's (see IN FLIGHT).
- Pneu 007 deploy: Railway project `pneu007-business`, service `pneu007`, https://pneu007-production.up.railway.app, `Dockerfile.legacy`. **Auto-deploys on push to `main`.**
- Old relay: project `pneu007-relay`, still serving the ice cream profile; deployed by `railway up` from this directory (`railway status` is linked to it).
- Correction to my earlier guess that "no Grok Bot is connected to Pneu 007": commit `300bbff` says a real business GrokBot was enrolled there, with a source-cited audit, operator activation and a registry lifecycle. Its "Not-tested" line: customer-agent booking and live Masumi payment.

## Landmines
- **Ownership of `/`:** in the unified Pneu 007 system the legacy static site owns `/`. Editing `apps/relay/src/site.ts` does **not** change the Pneu 007 homepage, but it does change Pneu 007's `/llms.txt`.
- **Not A2A standard:** `rel="agent-card"`, the `Link` header and `llms.txt` are conventions. Only `/.well-known/agent-card.json` is A2A standard. Don't claim otherwise in the demo.
- **Auto-deploy:** pushing to `main` deploys Pneu 007 production. Commit only your own files; never `git add -A`, because others have work in progress in the same tree.
- **Card availability:** the card is public, but `/a2a/jsonrpc` returns 503 until an owner-activated rulebook exists, so a discover can succeed while a conversation fails.
- **Instructions on the page:** keep the agent box informational ("talk to our agent at …"), not commands like "download and run this", so careful agents don't treat it as prompt injection.

## NEXT-SESSION PROMPT

```text
Read docs/handoffs/2026-10-09__0016__agent-discovery-on-pneu007-website.md first. Repo: /Users/clawdbot/hackathon001 (PRODUCTION Mac mini; GitHub zabrodsk/a2a-business-platform, pushes to main auto-deploy https://pneu007-production.up.railway.app).

Task: make every AI agent that visits the Pneu 007 website immediately see that Pneu 007 has its own agent and should talk to it via A2A instead of using the web form. The pattern already exists in apps/relay/src/site.ts (visible #ai-agents box, <link rel="agent-card">, Link header, /llms.txt), and the a2a CLI's discover already follows those hints. Apply it to apps/legacy, following "NOT STARTED" steps 1–7 of the handoff.

Before editing:
1. `git status`: another session may have uncommitted work in apps/legacy and apps/relay. Don't overwrite it; ask me if the files you need are dirty.
2. Read apps/relay/src/site.ts, apps/legacy/public/index.html (look for "pro-agenty") and apps/legacy/src/server.ts.

Then implement, add the legacy test, run `npm test -w @pneu007/legacy` and `npm test -w @pneu007/relay`, and show me the diff. Don't commit or push without my OK (push = production deploy). Never print tokens or secrets.
```
