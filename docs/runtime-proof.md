# Runtime proof

## Run 1: Polar Scoop ice cream test (2026-10-08, 21:56–22:07 Prague)

**Result:** one A2A task, `7463d554-15ad-417e-985d-be1c8a06a3fc`, went from creation to `TASK_STATE_COMPLETED` in 4 messages (2 turns per side). No human relayed any message.

| Item | Value |
| - | - |
| Relay | Railway `pneu007-relay`, https://relay-production-9e34.up.railway.app, `BUSINESS_PROFILE=icecream` |
| Protocol (customer → relay) | A2A v1.0, JSON-RPC binding, `@a2a-js/sdk` 1.3.0, bearer auth |
| Business side | Grok Bot (desktop app 0.68.1 on the Mac mini), identity `garage-demo`, private inbox API (not A2A), `inbox.mjs` |
| Customer side | Grok Bot, identity `customer-grok`, `a2a.mjs` (generic A2A client: discover → send) |
| Credentials | One-time enrollment codes, redeemed 19:56:29Z (business) and 19:57:47Z (customer). Tokens never shown in chat. |
| Wake-up mode | **Pre-started session:** Business ran `inbox watch` (long-poll). No webhook (`doorbell_skipped`). |
| Shop facts | `fixtures/icecream/shop.md`, given to the Business bot in its setup message |

### Timeline (relay event log, UTC)

| Time | Actor | Event | Message id |
| - | - | - | - |
| 19:57:57 | customer-grok | task created: "How much does one scoop cost, which flavours?" | `fa2fc11b-a9e1-42bc-b56e-4f6a7bf002e7` |
| 19:57:57 | garage-demo | work claimed | — |
| 19:58:00 | garage-demo | reply, INPUT_REQUIRED: 55 CZK, 4 flavours, hours, "place a pickup order?" | `17c3b87f-27c1-4604-b69b-de6467018961` |
| 19:58:04 | customer-grok | "2 scoops pistachio, cone, Fri 9 Oct 15:00, name Dusan, confirm total" | `a1ccb85a-fc2f-41b5-a795-19e570ae3b2a` |
| 19:58:04 | garage-demo | work claimed | — |
| 19:58:07 | garage-demo | reply, COMPLETED: "PS-0001 … Total 110 CZK, payable at pickup" | `94511787-7a2b-4dae-a115-8ab87047ed40` |

### Observed latency
- Business replied 3 s after each customer message (claim to reply).
- Customer's next message came 4 s after the Business reply.
- Whole task: 10 s.

### Matches expectations
- Price 55 CZK/scoop; total 2 × 55 = 110 CZK, within the customer's 120 CZK limit; order number PS-0001.
- The Business bot's own summary agrees with the log: one conversation, no off-menu requests, no errors.

### Not proven by this run
- **Separate accounts.** The relay cannot tell whether the two bots ran on different Grok Bot accounts; it only sees two different tokens. Confirm with the operator which account each bot used. The 3–4 s turn times are fast for two independent agents; that is not evidence either way, but it is worth confirming.
- **Customer-side result.** The Customer bot's report to its user was not captured here.
- **Unattended wake-up.** The Business bot was pre-started (`watch`), so this run is labelled "Pre-started agent sessions, not unattended wake-up".
- **Separate business website.** Discovery used the relay origin as the "website"; there was no separate shop site linking to the card.
- **A2A conformance.** Not checked by the official TCK yet.
