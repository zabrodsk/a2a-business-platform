// inbox — the Business agent's side of the relay. Private API, NOT A2A.
// Config: RELAY_URL and RELAY_TOKEN env vars, or ~/.a2a/inbox.json {"url": "...", "token": "..."}.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `inbox — pending customer conversations for the business agent

Usage:
  inbox enroll <redeem-url>           One-time setup: redeem an enrollment code, save the token locally
  inbox use-garage                    Import saved business tools credentials without a network request
  inbox read                          Claim and show all pending work items
  inbox wait [--timeout SEC]          Block until work arrives (default 50 s, max 55), then show it
  inbox watch [--minutes N]           Repeat 'wait' for N minutes (default 20); prints items as they come
  inbox reply <work-item-id> <text> [--state input-required|completed|rejected] [--data JSON]
                                      Managed replies include the lease saved by read/wait/watch.
  inbox show <task-id>                Show a task's full conversation
  inbox set-doorbell <webhook-url> --key KEY [--test]
                                      Register your wake-up webhook (e.g. a routine's webhook trigger).
                                      The relay POSTs to it with "Authorization: Bearer KEY" when work arrives.
                                      --test rings it once right away. The key can also come from stdin.
  inbox clear-doorbell                Stop the relay from ringing your webhook

Each work item is one customer message waiting for your answer. Answer every item exactly once.
--state input-required (default) hands the turn back to the customer; completed/rejected ends the task.
Config: RELAY_URL + RELAY_TOKEN, or INBOX_CONFIG (default ~/.a2a/inbox.json).
use-garage reads GARAGE_CONFIG (default ~/.a2a/garage.json). Use a separate INBOX_CONFIG for each business.
For managed relays, RELAY_URL is the provisioned https://host/relay/ID base (without /bot).
The token is never printed.`;

class CliError extends Error {}

const configFile = () => process.env.INBOX_CONFIG ?? join(homedir(), '.a2a', 'inbox.json');

type InboxConfig = { url: string; token: string };
function validatedConfig(value: unknown, httpsOnly = false): InboxConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const { url, token } = value as Partial<InboxConfig>;
    if (typeof url !== 'string' || typeof token !== 'string' || token.length < 24 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error();
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    const validBasePath = parsed.pathname === '/' || /^\/relay\/[A-Za-z0-9_-]{1,200}\/?$/.test(parsed.pathname);
    if (!/^https?:\/\/[^/?#]+(?:\/relay\/[A-Za-z0-9_-]{1,200})?\/?$/.test(url) || parsed.username || parsed.password || parsed.search || parsed.hash || !validBasePath
      || (parsed.protocol !== 'https:' && (httpsOnly || parsed.protocol !== 'http:' || !local))) throw new Error();
    return { url: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`, token };
  } catch { throw new CliError('Invalid private inbox configuration; use a valid business HTTPS origin and credential.'); }
}
function readPrivateConfig(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new CliError('Cannot read private configuration; check the file and enroll again.'); }
}
function saveConfig(file: string, value: InboxConfig) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch { throw new CliError('Cannot save private inbox configuration.'); }
  finally { rmSync(temporary, { force: true }); }
}
function config() {
  const file = configFile();
  const saved = (!process.env.RELAY_URL || !process.env.RELAY_TOKEN) && existsSync(file)
    ? validatedConfig(readPrivateConfig(file)) : undefined;
  const url = process.env.RELAY_URL || saved?.url;
  const token = process.env.RELAY_TOKEN || saved?.token;
  if (!url || !token) throw new CliError('Set RELAY_URL and RELAY_TOKEN, or run inbox use-garage with INBOX_CONFIG.');
  const resolved = validatedConfig({ url, token });
  if (!process.env.RELAY_TOKEN && saved && resolved.url !== saved.url) {
    throw new CliError('Saved credential belongs to another origin; select another INBOX_CONFIG.');
  }
  return resolved;
}

async function call(path: string, init: RequestInit = {}) {
  const { url, token } = config();
  const secrets = [token];
  if (typeof init.body === 'string') {
    try { const key = JSON.parse(init.body).key; if (typeof key === 'string' && key) secrets.push(key); } catch { /* no key */ }
  }
  try {
    const res = await fetch(`${url}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(path.startsWith('/bot/wait?') ? 65_000 : 30_000),
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 400 && path === '/bot/doorbell') {
        const denied = await res.json().catch(() => ({}));
        if (typeof denied.error === 'string' && /not allowed/.test(denied.error)) {
          throw new CliError('Webhook host not allowed; use the configured HTTPS allowlist.');
        }
      }
      throw new CliError(`Inbox request failed (HTTP ${res.status}).`);
    }
    let text = await res.text();
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Inbox request failed or timed out; check the configured origin and retry.');
  }
}

interface Item {
  work_item_id: string;
  task_id: string;
  customer: string;
  business_id?: string;
  connection_id?: string;
  execution_epoch?: number;
  claim_generation?: number;
  lease_until?: number;
  lease_token?: string;
  customer_identity?: { agent_id: string; acting_for: { type: string; id: string } | null };
  turn: number;
  max_turns: number;
  history: Array<{ from: string; text: string; data?: unknown }>;
}

function printItems(items: Item[], json: boolean) {
  const managed = items.filter((item) => item.lease_token);
  if (managed.length) {
    const file = `${configFile()}.leases.json`;
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const { url } = config();
    for (const item of managed) saved[`${url}:${item.work_item_id}`] = {
      lease_token: item.lease_token, claim_generation: item.claim_generation, lease_until: item.lease_until,
    };
    for (const [key, value] of Object.entries(saved)) {
      if ((value as { lease_until?: number }).lease_until! < Date.now()) delete saved[key];
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  if (json) return void console.log(JSON.stringify(items, null, 2));
  if (!items.length) return void console.log('No pending work.');
  for (const it of items) {
    console.log(`=== work item ${it.work_item_id}`);
    console.log(`task ${it.task_id} · customer ${it.customer} · your reply is turn ${it.turn}/${it.max_turns}`);
    if (it.customer_identity) {
      console.log(`Authenticated agent: ${it.customer_identity.agent_id} · acting for: ${it.customer_identity.acting_for?.id ?? 'no linked customer'}`);
    }
    for (const m of it.history) {
      console.log(`[${m.from}] ${m.text}`);
      if (m.data !== undefined) console.log(`[${m.from} data] ${JSON.stringify(m.data)}`);
    }
    console.log(`→ inbox reply ${it.work_item_id} "<your answer>" [--state input-required|completed|rejected]\n`);
  }
}

export async function inboxMain(rawArgs = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: rawArgs, allowPositionals: true,
    options: {
      state: { type: 'string' },
      'lease-token': { type: 'string' },
      'claim-generation': { type: 'string' },
      key: { type: 'string' },
      test: { type: 'boolean', default: false },
      data: { type: 'string' },
      timeout: { type: 'string' },
      minutes: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...args] = positionals;
  const json = values.json!;
  if (!cmd || values.help) return void console.log(HELP);

  switch (cmd) {
    case 'use-garage': {
      if (args.length || Object.entries(values).some(([name, value]) => !['json', 'help', 'test'].includes(name) || value)) {
        throw new CliError('usage: inbox use-garage (set GARAGE_CONFIG and INBOX_CONFIG through the environment)');
      }
      const source = readPrivateConfig(process.env.GARAGE_CONFIG ?? join(homedir(), '.a2a', 'garage.json'));
      if (!source || typeof source !== 'object' || Array.isArray(source) || (source as { role?: unknown }).role !== 'business_agent') {
        throw new CliError('Garage configuration must belong to a business agent.');
      }
      const imported = validatedConfig(source, true);
      const file = configFile();
      if (existsSync(file) && validatedConfig(readPrivateConfig(file)).url !== imported.url) {
        throw new CliError('Existing inbox belongs to another origin; select another INBOX_CONFIG.');
      }
      saveConfig(file, imported);
      console.log('Business inbox configured from garage credentials. Credentials saved privately.');
      return;
    }
    case 'enroll': {
      const [redeemUrl] = args;
      if (!redeemUrl) throw new CliError('usage: inbox enroll <redeem-url>');
      const res = await fetch(redeemUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new CliError(`Enrollment failed (HTTP ${res.status}).`);
      if (body.role !== 'business') throw new CliError('Enrollment is not for a business agent.');
      const file = configFile();
      saveConfig(file, validatedConfig(body));
      console.log('Business inbox enrolled. Credentials saved privately.');
      return;
    }
    case 'read':
      return printItems((await call('/bot/inbox')).items, json);
    case 'wait': {
      const timeout = Number(values.timeout ?? 50);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 55) throw new CliError('timeout must be between 1 and 55 seconds.');
      return printItems((await call(`/bot/wait?timeout=${timeout}`)).items, json);
    }
    case 'watch': {
      const minutes = Number(values.minutes ?? 20);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) throw new CliError('minutes must be greater than zero and at most 120.');
      const until = Date.now() + minutes * 60_000;
      while (Date.now() < until) {
        const { items } = await call('/bot/wait?timeout=50');
        if (items.length) {
          printItems(items, json);
          return; // hand control back to the agent so it can answer
        }
      }
      return void console.log('No work arrived during the watch window.');
    }
    case 'reply': {
      const [id, ...words] = args;
      const text = words.join(' ').trim();
      if (!id || !text) throw new CliError('usage: inbox reply <work-item-id> <text> [--state ...] [--data JSON]');
      let data: unknown;
      if (values.data) {
        try {
          data = JSON.parse(values.data);
        } catch {
          throw new CliError('--data must be valid JSON');
        }
      }
      const leaseFile = `${configFile()}.leases.json`;
      const leases = existsSync(leaseFile) ? JSON.parse(readFileSync(leaseFile, 'utf8')) : {};
      const lease = leases[`${config().url}:${id}`] ?? {};
      const r = await call('/bot/reply', {
        method: 'POST',
        body: JSON.stringify({ work_item_id: id, text, data, state: values.state ?? 'input-required',
          lease_token: values['lease-token'] ?? lease.lease_token,
          claim_generation: values['claim-generation'] ? Number(values['claim-generation']) : lease.claim_generation }),
      });
      if (json) return void console.log(JSON.stringify(r, null, 2));
      console.log(r.duplicate ? 'Already answered earlier; nothing sent.' : `Sent. Task ${r.task_id} is now ${r.state}.`);
      return;
    }
    case 'set-doorbell': {
      const [url] = args;
      if (!url) throw new CliError('usage: inbox set-doorbell <webhook-url> --key KEY [--test]');
      const key = values.key ?? (process.stdin.isTTY ? '' : readFileSync(0, 'utf8').trim());
      if (!key) throw new CliError('Provide the webhook key with --key or on stdin.');
      const r = await call('/bot/doorbell', { method: 'POST', body: JSON.stringify({ url, key, test: values.test }) });
      console.log(`Doorbell registered (${r.host}). The relay will ring it when customer messages arrive.`);
      if (r.test_ring) {
        console.log(
          r.test_ring.status === 200
            ? 'Test ring: HTTP 200, so a routine run should have started.'
            : `Test ring failed${r.test_ring.status ? ` (HTTP ${r.test_ring.status})` : ''}.`,
        );
      }
      return;
    }
    case 'clear-doorbell': {
      await call('/bot/doorbell', { method: 'DELETE' });
      console.log('Doorbell cleared.');
      return;
    }
    case 'show': {
      const [taskId] = args;
      if (!taskId) throw new CliError('usage: inbox show <task-id>');
      const t = await call(`/bot/tasks/${encodeURIComponent(taskId)}`);
      if (json) return void console.log(JSON.stringify(t, null, 2));
      console.log(`task ${t.task_id} · state ${t.state}`);
      for (const m of t.history) console.log(`[${m.from}] ${m.text}${m.data !== undefined ? `\n[${m.from} data] ${JSON.stringify(m.data)}` : ''}`);
      return;
    }
    default:
      throw new CliError(`Unknown command ${cmd}\n\n${HELP}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) inboxMain().catch((err) => {
  console.error(`error: ${err instanceof CliError ? err.message : 'Inbox command failed; check configuration and try again.'}`);
  process.exitCode = 1;
});
