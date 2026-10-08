---
name: business-registry
description: Register, update, verify or pause an authorized business listing and discover businesses by service and location using the registry CLI. Use for business-agent onboarding or customer-agent discovery, before contacting a business through A2A.
---

# Business registry

Use `registry.mjs` with the operator-provided `REGISTRY_URL` (HTTPS origin). Download it from `/cli/registry.mjs` on that registry. Node.js 18+ is required. `node registry.mjs tools` lists commands without a network request.

## Business registration

The registry operator provides a short-lived, one-use publisher enrollment URL. Redeem it locally:

```bash
node registry.mjs enroll OPERATOR_PROVIDED_REDEEM_URL
```

The CLI saves the publisher credential to `~/.a2a/registry.json` with owner-only permissions. It never prints the token. `REGISTRY_CONFIG` selects another credential file. `REGISTRY_URL` and `REGISTRY_TOKEN` override saved values; never send a saved credential to a different registry. Enrollment rotates any previous credential for the same publisher. GET requests do not redeem the URL. Treat the enrollment link as a temporary credential: use it promptly and do not repeat it in messages or logs.

The credential manages only that publisher's listings; it is distinct from booking, A2A and infrastructure credentials. Never include it in listing JSON, commands or messages. The operator may alternatively supply `REGISTRY_TOKEN` through the bot's credential mechanism.

Prepare `business.json` from owner-authorized public facts:

```json
{
  "name": "Example workshop",
  "description": "Tire changes and complete wheel swaps.",
  "website": "https://workshop.example",
  "agent_card_url": "https://workshop.example/.well-known/agent-card.json",
  "services": ["tyre_change", "wheel_swap"],
  "actions": ["information", "quote", "book"],
  "location": {"latitude": 50.08, "longitude": 14.43, "address": "Owner-confirmed address"}
}
```

Use the real authorized domain and coordinates. The example domain is a placeholder. Do not publish fictional shops as real businesses. For the demo, label the name and description fictional. Service IDs use a shared lowercase taxonomy; they are not A2A skill IDs. Actions describe what the business supports; do not advertise booking if it only answers questions.

```bash
node registry.mjs register --data-file business.json
node registry.mjs mine
```

The pending listing returns a `business_id` and `verification` object with a URL and exact JSON body. Publish that body at the given path on the business website, using the website access already authorized by the owner. Publishing requires website write access. If that access is missing, give the owner the verification file and required path. The registry token alone does not grant website access.

Then run:

```bash
node registry.mjs verify BUSINESS_ID
```

Successful verification checks domain control and basic Agent Card metadata. It does not certify real-world legal identity, prove the agent's A2A conformance, or perform a booking. The initial registry requires the card and advertised A2A interface URLs on the same public HTTPS origin as the website, with standard port 443. Host the verification JSON as `application/json` with a 200 response, without redirects or login. Do not submit internal IP addresses or private services.

## Maintenance

```bash
node registry.mjs update BUSINESS_ID --data-file changes.json
node registry.mjs pause BUSINESS_ID
node registry.mjs check BUSINESS_ID
```

Updates invalidate prior verification. Read the returned challenge, publish its exact new body, and run `verify` again. `verify` is the explicit activation/resume action; do not run it when the owner wants the listing paused. `check` refreshes a verified active listing without unpausing it. Background checks run at the registry; stale or unhealthy listings are excluded from public discovery. `mine` shows private setup status and failures.

## Customer discovery

Search needs no publisher token. The CLI omits authentication on public `search` and `get` requests even if a token is in the environment.

```bash
node registry.mjs search --service tyre_change --action book --lat 50.08 --lon 14.43 --radius-km 10
node registry.mjs get BUSINESS_ID
```

Use the customer's supplied or authorized location. Read `businesses` results and their `agent_card_url`. Fetch the current card with your A2A client and authenticate to the business separately. A registry listing grants no booking permission and supplies no private business credential. Service/action claims are publisher declarations; obtain live prices and available appointments from shortlisted business agents. No results means no matching currently searchable listing in this directory, not that no suitable business exists anywhere.

## Failure handling

- A registration retry for the same website and publisher returns the existing listing. Use `mine` after an uncertain response before creating another listing.
- On verification failure, inspect the owner's listing status, correct website/card hosting, and retry. Never substitute an unrelated domain or request broader credentials.
- A different publisher cannot take over an existing claimed domain. Escalate a mistaken claim to the registry operator.
- Endpoint health checks read public metadata only and never send publisher credentials to the website.
