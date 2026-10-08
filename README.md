# A2A Business Platform

Infrastructure for personal agents to discover business agents, negotiate service offers, and complete authorized transactions.

A customer should be able to tell their agent, **“I need my tires swapped,”** and have it find businesses that accept agent requests, obtain current offers, and book within the customer's approved limits. This hackathon project brings the discovery, communication, business tools, rules, and payment adapters into one repository.

**Pneu 007 is the fictional test business used to exercise the platform.** The tire-shop website and reservation backend are a sandbox for the A2A workflow.

Its demo location is **Holešovice, Praha 7**. For “find me an autorepair shop in Holesovice,” GrokBot searches the public registry for that area, checks the returned website's Agent Card, and describes the demo's tyre-service scope. This works before search engines index the new site; the registry search matches both accented and unaccented area names. General website discovery remains available for future businesses.

[Registry API](https://business-registry-production.up.railway.app) · [Demo business website](https://pneu007-production.up.railway.app) · [Registry API and setup](docs/business-registry.html) · [Agent tools](docs/grokbot-tools.html) · [Registry GrokBot proof](docs/registry-runtime-proof.html) · [Earlier A2A evidence](docs/runtime-proof.md)

## The agent-to-agent flow

1. **Onboard a business.** Its agent reads the public website and authorized internal sources, proposes a cited operating rulebook, and obtains owner activation.
2. **Become discoverable.** Publish the business's Agent Card on its website. The business agent can also register a public profile; website-control verification and card checks activate its directory listing.
3. **Find a suitable business agent.** The customer's agent finds official websites through ordinary web search, or searches the registry, then checks the current Agent Cards against the requested service and location.
4. **Negotiate an offer.** The agents exchange A2A messages. The business agent uses live pricing and appointment tools and requests owner approval for permitted exceptions.
5. **Authorize and execute.** The customer's agent accepts a specific offer within a human-approved mandate. The backend checks permissions and capacity before initiating checkout.
6. **Report the saved result.** Agents use persisted order, payment, and reservation states. A quoted offer, held appointment, verified funding, confirmed booking, and completed service are separate events.

Discovery can start with ordinary web search: GrokBot finds candidate businesses, confirms their official websites, and checks those sites for Agent Cards. The registry is an additional discovery source. Each business remains responsible for its own systems, operating rules, and fulfillment.

## Website-first discovery

Ask GrokBot to read the [website-discovery skill](skills/a2a-website-discovery/SKILL.md), search for a service and area, and scan the official websites it finds. No Google Maps API key or registry credential is required. The bundled helper checks public Agent Cards and explicit website links and returns bounded evidence; it does not perform the initial web search or certify geographic/service relevance.

```bash
node discover-sites.mjs --sites-file candidates.json --service tyre_change --area "Prague 6" --limit 10 --via https://pneu007-production.up.railway.app --output report.json
```

Download the helper at `/cli/discover-sites.mjs` and the skill at `/skills/a2a-website-discovery/SKILL.md` from the demo or registry origin. Hosted mode lets GrokBot scan through its network proxy while Railway retains DNS/address protections; omit `--via` for direct scans on ordinary networks. See the [workflow and report guide](docs/web-discovery.html) and [actual GrokBot demo test](docs/web-discovery-runtime-proof.html). A missing card in a bounded scan is reported as “no card found,” and a discovered card's booking claims remain unverified until exercised.

## Components

| Component | Responsibility | Source |
| --- | --- | --- |
| Business registry | Registration, website ownership proof, Agent Card checks, service/location search, listing health and pausing | `apps/registry` |
| A2A transport | Agent Card discovery, A2A 1.0 JSON-RPC tasks, conversation state, and authenticated identities | `apps/relay` |
| Business-agent tools | Read sources, check availability, calculate quotes, initiate authorized checkout, and inspect reservations | `packages/agent-client`, `skills` |
| Audit and rulebooks | Source citations, versioned proposals, human owner activation, and stale-policy checks | `packages/audit` |
| Customer mandates and business policy | Scope customer authorization and constrain quotes, discounts, acceptance, and purchases | `apps/legacy/src/agent-policy.ts` |
| Payment adapters | Explicit local simulation and Masumi Cardano Preprod integration | `packages/payments`, `infra/masumi` |
| Demo business adapter | Pneu 007 website, service catalog, reservations, customer fixtures, calendar, and supplier mocks | `apps/legacy`, `packages/demo-garage`, `fixtures` |

The customer-facing transport uses A2A. The business bot uses a private inbox and authenticated business tools behind that endpoint. These internal HTTP operations are distinct from the A2A protocol. Bots can use the bundled terminal clients; no native GrokBot plugin installation is assumed.

## One repository, two application services

All hackathon work lives in **[zabrodsk/a2a-business-platform](https://github.com/zabrodsk/a2a-business-platform)**. The earlier standalone registry repository is archived and points here.

```text
Customer agent → Web search / optional registry → Business Agent Card
Customer agent ↔ A2A endpoint ↔ Business agent
                                  ↓
                           Business tools
                                  ↓
                    Booking / rules / payments
```

The demo deploys the business adapter and A2A endpoint together. The directory can run as a separate service from the same repository.

| Railway service | Build file | Persistent data |
| --- | --- | --- |
| Demo business + A2A | `Dockerfile.legacy` | `/data/legacy.db`, `/data/legacy-relay.db` |
| Business registry | `Dockerfile.registry` | `/data/registry.db` |

Both use `main`, one replica each, their own persistent volume and credentials, and `/healthz` health checks. The root `Dockerfile` is available for running the transport relay alone.

The existing Railway project is named `pneu007-business`; that is its deployment identifier. Both services can source this A2A-focused repository. The optional `.railway/railway.ts` manages only the registry portion of that project and requires an explicit CLI plan/apply. It is not applied automatically on push. See the [deployment runbook](docs/railway-deployment.html).

## Run locally

Use Node.js 22 and npm. Installing the SQLite driver may require a C/C++ build toolchain.

```bash
npm ci
npm run typecheck
npm test
npm run start:system
```

The demo website, business tools, and A2A endpoint run together at `http://127.0.0.1:8797`. Development credentials are generated privately in `data/legacy-access.json`; the file and databases are excluded from Git. Production requires explicit secrets and persistent storage.

Run the registry in another terminal with a strong `REGISTRY_ADMIN_TOKEN` set through your environment:

```bash
npm run start:registry
```

It listens on port 8792 by default. On Railway, leave `REGISTRY_HOST` and `REGISTRY_PORT` unset so production uses `0.0.0.0` and the platform `PORT`. Attach a volume at `/data` and set `REGISTRY_DB_PATH=/data/registry.db`. The registry refuses Railway startup if its database is outside a mounted volume.

## Agent clients

`npm run build` creates dependency-free Node.js clients in `packages/agent-client/dist`:

- `a2a.mjs`: discover a business's live Agent Card and exchange A2A messages.
- `inbox.mjs`: receive customer work and return the business bot's replies.
- `garage.mjs`: operate the demo business through its authenticated API.
- `customer.mjs`: link a customer agent, save private credentials, open cases and mandates, accept an authorized offer, and inspect its order.
- `registry.mjs`: register, verify, update, pause, and discover businesses.
- `discover-sites.mjs`: inspect official candidate websites from a web search for A2A support, without registry access or credentials.

[Business-agent instructions](skills/pneu007-business/SKILL.md) and [registry instructions](skills/business-registry/SKILL.md) explain setup, credentials, and the workflow. Human owner approvals and customer mandates remain backend-enforced; the bot cannot grant itself broader authority.

The [customer booking skill](skills/a2a-customer-booking/SKILL.md) uses the business's `/auth.md` instructions and existing customer login. The human confirms the agent at `/agent/claim`, separately reviews purchase limits at `/agent/mandates?mandate_id=…`, and can revoke agent access at `/agent/access`. No external identity-service subscription is required. Credentials remain in private, origin-bound files; linking does not grant booking or payment approval. See [authentication and customer linking](docs/auth.html).

The autoshop business bot imports its existing garage enrollment with `inbox.mjs use-garage`, using a separate `INBOX_CONFIG` for Pneu 007. The [Pneu wake-up instructions](prompts/grokbot-pneu-business-doorbell.md) use an actual native webhook routine and live business tools; runtime availability must be verified separately from a successful webhook registration.

## What is verified

- Automated tests cover discovery, authentication, registry ownership and search, business policy, reservation conflicts, idempotency, persistence, and payment-adapter behavior.
- GitHub CI runs workspace typechecks/tests and builds both application images.
- The Pneu 007 test business is deployed on Railway. Its website, booking API, calendar, and audit-source access have been checked over HTTPS.
- An actual business GrokBot completed registry enrollment, registration, proof publication, verification, update, pause and reactivation. Read [the live registration report](docs/registry-runtime-proof.html).
- An earlier small GrokBot conversation through A2A is recorded in [runtime proof](docs/runtime-proof.md), including its limitations.

Actual customer and business GrokBots completed discovery, account linking, unattended negotiation, human mandate approval and a deposit-funded confirmed booking. Read the [live customer booking report](docs/customer-booking-runtime-proof.html). Both bots ran in the currently logged-in GrokBot account; distinct-account isolation remains unverified. The registry is deployed at https://business-registry-production.up.railway.app. Directory verification checks website control and basic Agent Card metadata; advertised booking capabilities remain publisher declarations. The initial directory supports up to 100 listings.

Development payments default to **`local_demo`**, an explicitly labeled local simulation. The deployed demo uses **Masumi Cardano Preprod**; [live payment evidence](docs/masumi-live-proof.html) records actual funding, receipt and seller settlement, while each new order retains its own payment state. See [Masumi setup](docs/masumi-setup.html). There are no real garage services or mainnet payments in the demo.
