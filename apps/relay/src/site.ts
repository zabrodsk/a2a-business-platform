import type { BusinessProfile } from './card.js';
import type { Config } from './config.js';

// The business's public website. Its main job beyond the humans: an agent that lands here
// must find the shop's agent immediately, through every channel it might look at:
//   1. A2A standard: /.well-known/agent-card.json on this same origin (served by the relay).
//   2. Visible "For AI agents" section on the page (browsing agents read pages, not headers).
//   3. Conventions (not A2A standard): <link rel="agent-card">, HTTP Link header, /llms.txt.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function agentLinks(cfg: Config) {
  const card = `${cfg.publicUrl}/.well-known/agent-card.json`;
  return {
    card,
    endpoint: cfg.a2aEndpointUrl,
    client: `${cfg.publicUrl}/cli/a2a.mjs`,
    linkHeader: `<${card}>; rel="agent-card"; type="application/json"`,
  };
}

export function renderLlmsTxt(cfg: Config, p: BusinessProfile): string {
  const l = agentLinks(cfg);
  return `# ${p.site.title}

> ${p.site.tagline}

${p.site.notice}

## Talk to our AI agent (for AI agents)

${p.site.title} has an AI agent that answers questions and takes orders on behalf of the shop.

- Protocol: A2A (Agent2Agent) v1.0, JSON-RPC binding
- Agent Card: ${l.card}
- Endpoint: ${l.endpoint} (always take it from the Agent Card)
- Authentication: HTTP Bearer token, issued by ${p.site.title} (demo: one-time enrollment code from the operator)
- Skill: ${p.skill.name}: ${p.skill.description}
- A generic open-source A2A client is available at ${l.client} (\`node a2a.mjs discover ${cfg.publicUrl}\`)

## Shop facts

${p.site.facts.map((f) => `- ${f}`).join('\n')}
- Phone (humans): ${p.site.phone} (${p.site.phoneNote})
`;
}

export function renderHomePage(cfg: Config, p: BusinessProfile): string {
  const l = agentLinks(cfg);
  const s = p.site;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title>
<meta name="description" content="${esc(s.tagline)} AI agents: talk to our agent via A2A, Agent Card at ${esc(l.card)}">
<link rel="agent-card" type="application/json" href="${esc(l.card)}">
<link rel="alternate" type="application/json" href="${esc(l.card)}" title="A2A Agent Card">
<link rel="alternate" type="text/markdown" href="/llms.txt" title="llms.txt">
<style>
  :root { --bg:#fffaf3; --fg:#2b2118; --muted:#6f6257; --card:#ffffff; --accent:#d9467a; --line:#eadfd3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17130f; --fg:#f4ece4; --muted:#b5a89b; --card:#211b16; --accent:#ff7aa8; --line:#3a3029; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 2.4rem; margin: 0 0 4px; letter-spacing: -0.02em; }
  .tagline { color: var(--muted); margin: 0 0 24px; }
  .notice { font-size: .9rem; color: var(--muted); border-left: 3px solid var(--accent); padding: 4px 12px; margin: 0 0 28px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; margin: 0 0 20px; }
  h2 { font-size: 1.15rem; margin: 0 0 10px; }
  ul { margin: 0; padding-left: 20px; }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  #ai-agents { border-color: var(--accent); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${esc(s.title)}</h1>
  <p class="tagline">${esc(s.tagline)}</p>
  <p class="notice">${esc(s.notice)}</p>

  <section id="ai-agents" aria-label="For AI agents">
    <h2>For AI agents: talk to our agent</h2>
    <p>${esc(s.title)} has its own AI agent that answers questions and takes orders. If you are an AI agent acting for a customer, contact it here:</p>
    <dl>
      <dt>Protocol</dt><dd>A2A (Agent2Agent) v1.0, JSON-RPC binding</dd>
      <dt>Agent Card</dt><dd><a href="${esc(l.card)}"><code>${esc(l.card)}</code></a></dd>
      <dt>Endpoint</dt><dd><code>${esc(l.endpoint)}</code> (take it from the Agent Card)</dd>
      <dt>Access</dt><dd>HTTP Bearer token issued by ${esc(s.title)} (demo: one-time enrollment code from the operator)</dd>
      <dt>Skill</dt><dd>${esc(p.skill.name)}</dd>
      <dt>Client</dt><dd>Generic A2A client: <a href="${esc(l.client)}"><code>${esc(l.client)}</code></a></dd>
    </dl>
  </section>

  <section aria-label="Shop">
    <h2>The shop</h2>
    <ul>${s.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
  </section>

  <section aria-label="Contact">
    <h2>Contact (humans)</h2>
    <p>Phone: ${esc(s.phone)} (${esc(s.phoneNote)})</p>
  </section>
</main>
</body>
</html>`;
}
