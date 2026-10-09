# Business agent — Agent Card, Handle token and registry publication

Copy the prompt below and replace the website and Handle URLs. Website/CMS access is supplied through the agent's secure credential mechanism. The registry address is already included.

Handle issues the private business-connection token after independent owner consent. This prompt does not create a human owner's login token, a registry publisher token or a webhook secret. Those credentials have separate purposes.

The current Pneu demo Handle deployment at `https://pneu007-production.up.railway.app` supports its own website origin, not arbitrary external business onboarding. For that demo, use this URL for both website and Handle. For another business, use an installation that actually supports it; an unsupported website must be reported as a blocker.

## Copyable prompt

```text
Prepare my business so customer agents can discover and contact it.

Business website: [WEBSITE_URL]
Handle: [HANDLE_URL]
Registry: https://business-registry-production.up.railway.app

Use my securely supplied website/system access. This task authorizes setup, the exact website ownership/registry verification challenges, and publication of the approved Agent Card and a visible “For agents” link. Keep other website content intact. Human Handle consent, rule activation and operation/publication grants must still be recorded through Handle's supported owner flow; never approve them for me. Do not place orders or make payments during setup.

1. Inspect the website and identify the business, services and existing agent service. Read Handle's live managed bootstrap and its linked instructions. Use the actual supported API, schemas and authentication; do not substitute a prepared open demo for fresh onboarding. If this installation does not support my website, report that precisely.

2. Resume your existing valid connection if present. Otherwise register your own business-agent identity, save the provisional credential privately, and give me the returned secure website-verification/owner-consent link and code. I will authenticate and decide independently. Keep the setup active with bounded status checks, or a verified native continuation, and resume after server-confirmed approval.

3. Have Handle issue your private business-connection access token through its supported credential exchange. Save it in your secret store or a private credential file; never print it in chat, logs, Git, the website or the Agent Card. Validate it with Handle's authenticated identity endpoint and record its actual business/connection IDs, scopes and audience. Reuse a valid saved token rather than create duplicates. On uncertain exchange delivery, recover the recorded state instead of blindly exchanging again. Do not invent a token or borrow my human session. Tell me where it is securely stored without revealing its value.

4. Provision or reuse the actual business relay through Handle. Prove pre-audit private receipt/reply. Audit approved existing sources, archive redacted evidence, propose only supported operating rules, and obtain my independent activation of the exact rule version and required scopes before public operation. Do not infer authority from marketing text or historical orders.

5. Configure the business agent's actual supported webhook and verify that a request wakes the agent, reaches its private inbox and produces a reply. Keep webhook credentials separate from the Handle token. If native wake-up is unavailable, report the limitation and any supported polling fallback; do not claim automatic availability from a saved routine alone.

6. After activation, operational readiness and the recorded publication grant, obtain the validated Agent Card from Handle. Include the real business identity, supported skills, actual A2A endpoint/protocol and authentication requirements. Publish it as JSON at /.well-known/agent-card.json and add a visible direct “For agents” link. Exclude private tokens, webhook secrets, internal rules and untested capabilities. Reuse the existing valid publication where possible.

7. Read the registry's live business-registration instructions. Register or update this business using separate authorized publisher access, publish its exact website challenge and verify the listing. The Handle access token is not a registry publisher token. If publisher access is missing or the registry rejects the website/card/interface arrangement, report the specific blocker; do not invent a credential or change the business endpoint to force verification.

8. Verify discovery by querying the registry for our actual service and location, fetching the returned website/current card, and exercising the connection with a separate permitted customer test identity. Verify the Handle token privately, the website card publicly, and webhook receipt/reply separately. Do not claim complete setup from HTTP 200, a published card or an active listing alone.

Finish with a short report: public card URL, registry listing/search result, whether the private Handle token was issued and validated, where it is stored, actual wake-up/reply evidence, and any remaining blocker. No secret values. Keep technical details private unless I ask for them.
```
