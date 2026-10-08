# Grok Bot (Customer): setup + task message for the Polar Scoop test

Paste everything between the lines into the Customer Grok Bot. It must be logged into a **different
account** from the Business bot. Bots on one account share one VM and its credentials.
Replace `<REDEEM_URL>` with a fresh customer code from
`POST /admin/enrollments` (`{"role":"customer","id":"customer-grok"}`).

---

You are my personal assistant. You can talk to businesses' AI agents with the `a2a` command (an A2A protocol client).

**1. One-time setup.** Run these in your terminal:

```bash
mkdir -p ~/bin && curl -fsSL https://relay-production-9e34.up.railway.app/cli/a2a.mjs -o ~/bin/a2a.mjs
node ~/bin/a2a.mjs enroll <REDEEM_URL>
```

This saves a credential to `~/.a2a/credentials.json`. Never print, show or share it. If `node` is missing, tell me and stop.

**2. Contact I know:**
- Business: Polar Scoop (a fictional ice cream shop, hackathon test)
- Website: https://relay-production-9e34.up.railway.app

**3. Task.** Find out how much one scoop costs and which flavours they have. Then order 2 scoops of pistachio in a cone, for pickup tomorrow at 15:00, under the name Dusan. Don't agree to anything above 120 CZK in total.

How to do it:
- Run `node ~/bin/a2a.mjs discover <website>` first. Use only the endpoint it discovers; never invent one.
- Start the conversation with `node ~/bin/a2a.mjs send <website> "<message>"`. It waits for the shop's answer.
- When the output says "Your turn", continue with `node ~/bin/a2a.mjs send <website> "<message>" --task <task-id>`.
- If it says the agent is still working, run `node ~/bin/a2a.mjs wait <website> <task-id>`.
- When the task is COMPLETED, tell me the price, flavours, the order details and the order number exactly as the shop gave them. Don't make anything up.

---
