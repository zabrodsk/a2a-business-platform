# Relay hosting (test environment)

Railway project `pneu007-relay` (workspace "Dusan Zabrodsky's Projects"), service `relay`, environment `production`.

- Public URL: https://relay-production-9e34.up.railway.app
- Agent Card: https://relay-production-9e34.up.railway.app/.well-known/agent-card.json
- A2A endpoint: https://relay-production-9e34.up.railway.app/a2a/jsonrpc
- CLIs for the bots: `/cli/a2a.mjs` (Customer), `/cli/inbox.mjs` (Business)
- Persistent volume `relay-volume` mounted at `/data`; SQLite at `/data/relay.db`.
- Build: root `Dockerfile` (Node 22, compiles better-sqlite3, bundles the CLIs, runs `a2a-db upgrade` then the server).

## Secrets

Tokens live in `.env.railway` at the repo root (mode 600, gitignored) and in Railway service variables.
Never paste them in chat or commit them. Hand each bot only its own token:

| Variable | Who gets it |
|---|---|
| `CUSTOMER_TOKENS` (`customer-a:<token>`) | Customer GrokBot account |
| `BUSINESS_TOKEN` | Business GrokBot account |
| `ADMIN_TOKEN` | Us only (`/admin/events`) |

Business webhook is not configured yet. Once the Business routine's URL and key are known:

```bash
railway variables --set BUSINESS_WEBHOOK_URL=... --set BUSINESS_WEBHOOK_KEY=...
```

## Redeploy

From the repo root (linked to the project):

```bash
railway up --detach
```

Smoke check: `curl -s https://relay-production-9e34.up.railway.app/healthz` should return `{"ok":true}`.
