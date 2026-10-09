# Customer GrokBot — registry discovery

Give GrokBot the `skills/handle-customer/SKILL.md` file once, or use the hosted skill URL after the registry deployment includes it:

> Load https://business-registry-production.up.railway.app/skills/handle-customer/SKILL.md as your customer discovery skill. If your runtime supports persistent skills, save it for future service requests; otherwise use it in this chat and state that limitation briefly. Use its registry to find businesses, read their current Agent Cards, and contact them through their advertised A2A services. Do not ask me to supply the registry URL each time. Only book or pay within my explicit approval and the business's supported customer authorization flow.

Then ask naturally:

> Find a tyre service in Holešovice and ask for a quote. Do not book or pay.

The skill supplies the registry, not a preselected shop or endpoint. A successful search proves discovery; a real business-agent reply separately proves the connection and wake-up path.
