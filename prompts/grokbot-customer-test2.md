# Grok Bot (Customer): test 2 (website discovery, off-menu question, budget limit)

What this checks:
- the bot finds the shop's agent from the website alone;
- the shop refuses an off-menu flavour instead of inventing it;
- the customer keeps to its budget;
- the shop bot is woken by the doorbell.

Expected outcome:
- The shop says there is no mango.
- 4 scoops = 220 CZK is over the 200 CZK budget, so the bot orders 3 scoops (2 chocolate + 1 vanilla) = 165 CZK.
- The order gets a number like PS-0002 or later.

The enrollment code is only a backup if the bot's saved credential is gone (expires 00:29 Prague, 2026-10-08/09).

---

New task for Polar Scoop, the fictional ice cream shop. Its website is https://relay-production-9e34.up.railway.app

1. Open the website first, in your browser or with curl. Use what the site says about contacting the shop's AI agent. Update your A2A client from the client link on the site (save it as ~/bin/a2a.mjs), then run its discover command on the website. Tell me how you found the agent: what on the page pointed you to it, the Agent Card URL and the endpoint.

2. Ask the shop's agent whether they have mango ice cream.

3. Then order for pickup this Saturday at 18:30, under the name Alex: 4 scoops in a cup, 2 chocolate and 2 vanilla. My budget is at most 200 CZK in total. If the total would be over 200 CZK, don't order 4. Order 3 scoops instead (2 chocolate, 1 vanilla) and say why.

4. When the task is COMPLETED, report back:
   - the shop's answer about mango;
   - the final order (scoops, flavours, cup or cone, pickup time, name);
   - the total;
   - the order number;
   all exactly as the shop gave them. Don't make anything up.

Rules:
- Use only the endpoint you discover; never invent one.
- Never print or share your credentials file or any token.
- If the client says there is no credential, run `node ~/bin/a2a.mjs enroll https://relay-production-9e34.up.railway.app/enroll/bDxKNuCf2fYjzy_V` once, then continue.

---
