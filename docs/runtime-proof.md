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

## Run 2: unattended wake-up via webhook routine (2026-10-08, 23:25–23:27 Prague)

**Result:** The Business Grok Bot was idle (no `watch` running). A customer message rang its "Polar Scoop doorbell" routine. The routine woke the bot, and it answered correctly, twice in a row. Task `8feaa142-b928-49eb-a0f5-d4bae9667db3` ended in `TASK_STATE_COMPLETED`.

| Item | Value |
| - | - |
| Doorbell | Registered by the bot itself (`inbox set-doorbell`). Host `api2.cursor.sh`, routine webhook `/automations/webhook/da94012c-a1f7-5203-aad1-c5ab8445375e`. Key in Grok Bot's secure field and the relay DB; never shown or logged. |
| Test ring | 21:25:38Z, HTTP 200, `runUuid 0c79d1a5-9732-4778-aaee-d05dab1107be` |
| Customer | `customer-a`, played by the `a2a` CLI on the Mac mini (scripted, **not** a Grok Bot) |

### Timeline (UTC)

| Time | Event |
| - | - |
| 21:26:00 | customer-a: "Are you open tomorrow at noon, how much would 3 scoops of strawberry in a cup cost?" → doorbell rung, HTTP 200 |
| 21:26:07 | Business bot claimed the work item (woken by the routine) |
| 21:26:15 | Reply, INPUT_REQUIRED: "open every day 11:00–20:00 … 3 scoops … 165 CZK (55 CZK per scoop) … take a pickup order?" |
| 21:26:27 | customer-a: "No order for now … bye!" → doorbell rung, HTTP 200 |
| 21:26:35 | Business bot claimed the work item |
| 21:26:45 | Reply, COMPLETED: "You are welcome! … 11:00–20:00. Bye!" |

### Observed latency
- Doorbell ring to claim: 7–8 s.
- Doorbell ring to reply: 15–18 s.
- Customer's blocking `send` returned 16 s and 19 s after sending.

### Not proven by this run
- **Customer side:** the customer was a script here, not a Grok Bot. Run 1 had a Grok Bot customer, but with a pre-started Business session.
- **Next step:** a run where both sides are real Grok Bots and the Business bot is woken by the doorbell.
- **Edge cases:** behaviour when two customer messages arrive while a routine run is still going (Grok webhook calls are not queued; the relay re-rings unclaimed items every 60 s) is untested.

## Run 3: Grok Bot ↔ Grok Bot with unattended wake-up (2026-10-08, 23:33 Prague)

**Result:** first run with a real Grok Bot on **both** sides **and** the Business bot woken only by its webhook routine (no `watch`). Task `81bf9c1b-c778-4124-85f0-bfdd70c0153e` went from creation to `TASK_STATE_COMPLETED` in 28 s. No human relayed any message.

The customer bot (`customer-grok`) was given only the website URL plus a task: ask about mango; order 4 scoops; budget max 200 CZK, so fall back to 3 scoops if over. It used its saved credential from Run 1; the backup enrollment code was not redeemed.

### Timeline (UTC)

| Time | Actor | Event | Message id |
| - | - | - | - |
| 21:33:24 | customer-grok | "Do you have mango ice cream? … price of one scoop?" → doorbell rung, HTTP 200 | `5c42ffee-c14f-44a4-90ed-6bd68b99b436` |
| 21:33:30 | garage-demo | woken, claimed | — |
| 21:33:36 | garage-demo | INPUT_REQUIRED: "Sorry, we do not have mango. … vanilla, chocolate, strawberry, and pistachio. One scoop is 55 CZK" | `0ec377d9-2b38-42ab-868f-cbf9d72ca483` |
| 21:33:40 | customer-grok | "4 scoops … 220 CZK … over my budget limit of 200 CZK. So instead please: 3 scoops in a cup, 2 chocolate and 1 vanilla … Sat Oct 10, 18:30 … Alex" → doorbell rung, HTTP 200 | `ca04e1d6-8cc1-4846-a962-44977d7765c7` |
| 21:33:46 | garage-demo | woken, claimed | — |
| 21:33:52 | garage-demo | COMPLETED: "Order confirmed: PS-0002 for Alex — 2 chocolate + 1 vanilla (3 scoops) in a cup, pickup Sat 10 Oct 2026 at 18:30. Total 165 CZK" | `1aa30aff-4964-4aa6-935b-66c0a397974c` |

### Observed latency
- Doorbell ring to claim: 6 s (both turns).
- Ring to reply: 12 s (both turns).
- Customer's next message came 4 s after the shop's reply.

### Checks
| Check | Result |
| - | - |
| Shop refused an off-menu flavour | Said no mango; invented nothing. |
| Customer kept its budget | 220 > 200, switched to 3 scoops (165 CZK) and said why. |
| Prices and arithmetic | 3 × 55 = 165 CZK. |
| Order numbering | PS-0002, continuing from PS-0001 via the bot's `~/polar-scoop/orders.log`. |
| Wake-up | Webhook routine both turns; no pre-started session. |

### Not proven by this run
- **Website discovery path.** Reported by the customer bot, relayed by the operator: it fetched the home page first and found the "For AI agents" section, then checked `/.well-known/agent-card.json`. Both pointed to the same Agent Card. This is the bot's own account; the relay does not log page or card fetches, so there is no server-side record of it.
- **Separate accounts.** Still unconfirmed from the relay side (see Run 1).
- **Concurrency.** Untested: two customers at once, or a ring arriving while a routine run is busy.
