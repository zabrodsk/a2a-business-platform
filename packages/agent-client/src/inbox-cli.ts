// inbox — the Business agent's side of the relay. Private API, NOT A2A.
// Config: RELAY_URL and RELAY_TOKEN env vars, or ~/.a2a/inbox.json {"url": "...", "token": "..."}.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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
  inbox setup-wakeup --config-file PRIVATE_JSON
                                      Register the native routine's {url,key}; return pending and yield for its probe.
  inbox wakeup-status                 Read verified automatic wake-up status without sending a test.
  inbox acknowledge-wakeup --event-file PRIVATE_JSON
                                      Native routine only: acknowledge setup_probe.token from its actual webhook event.
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
    try {
      const payload = JSON.parse(init.body);
      for (const name of ['key', 'probe_token']) if (typeof payload[name] === 'string' && payload[name]) secrets.push(payload[name]);
    } catch { /* no secret-bearing payload */ }
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

function readWakeupFile(file: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0) throw new Error();
    const buffer = Buffer.alloc(16_385);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > 16_384) throw new Error();
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch { throw new CliError('Wake-up input must be a valid JSON object in a private regular file (mode 0600, at most 16 KiB).'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function wakeupConfig(file: string): { url: string; key: string } {
  try {
    const value = readWakeupFile(file) as { url?: unknown; key?: unknown };
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !['url', 'key'].includes(name))
      || typeof value.url !== 'string' || value.url.length > 4096 || typeof value.key !== 'string' || value.key.length < 8
      || value.key.length > 512 || /[\r\n\x00]/.test(value.key)) throw new Error();
    const parsed = new URL(value.url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.url.includes('#')) throw new Error();
    return { url: parsed.toString(), key: value.key };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Wake-up configuration must contain only an HTTPS callback url without credentials or fragment, and its private key.');
  }
}
const WAKEUP_STATES = ['unconfigured', 'unverified', 'pending', 'verified', 'expired'] as const;
type WakeupStatus = {
  configured: boolean; ready: boolean; verification_state: typeof WAKEUP_STATES[number];
  webhook_fingerprint: string | null; host?: string; verified_at?: string; expires_at?: string;
};
function safeWakeupStatus(value: unknown): WakeupStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('Invalid wake-up status response.');
  const status = value as Record<string, unknown>;
  const fingerprint = status.webhook_fingerprint ?? null;
  if (typeof status.configured !== 'boolean' || typeof status.ready !== 'boolean'
    || !WAKEUP_STATES.includes(status.verification_state as WakeupStatus['verification_state'])
    || !(fingerprint === null && !status.configured || typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint))
    || status.ready && (!status.configured || status.verification_state !== 'verified' || !status.webhook_fingerprint)) {
    throw new CliError('Invalid wake-up status response.');
  }
  const safe: WakeupStatus = { configured: status.configured, ready: status.ready,
    verification_state: status.verification_state as WakeupStatus['verification_state'], webhook_fingerprint: fingerprint as string | null };
  if (typeof status.host === 'string' && status.host.length <= 253 && /^[a-z0-9.-]+$/i.test(status.host)) safe.host = status.host;
  for (const name of ['verified_at', 'expires_at'] as const) {
    if (typeof status[name] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(status[name]) && Number.isFinite(Date.parse(status[name]))) safe[name] = status[name];
  }
  if (safe.ready && safe.expires_at && Date.parse(safe.expires_at) <= Date.now()) {
    safe.ready = false; safe.verification_state = 'expired';
  }
  return safe;
}
function printWakeupStatus(status: WakeupStatus, outcome: string) {
  console.log(JSON.stringify({ ...status, outcome, next_action: status.ready ? 'handle_inbox_on_native_webhook'
    : status.verification_state === 'pending' ? 'yield_to_native_routine' : 'configure_and_verify_native_routine', ...(status.verification_state === 'pending' ? { instruction: 'End this setup turn now so the native routine can run and acknowledge its webhook probe. Check wakeup-status afterward; HTTP 200 alone is not readiness.' } : {}) }, null, 2));
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
      'config-file': { type: 'string' },
      'event-file': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...args] = positionals;
  const json = values.json!;
  if (!cmd || values.help) return void console.log(HELP);

  switch (cmd) {
    case 'setup-wakeup': {
      if (args.length || !values['config-file'] || Object.entries(values).some(([name, value]) => !['config-file', 'json', 'help', 'test'].includes(name) || name === 'test' && value)) {
        throw new CliError('usage: inbox setup-wakeup --config-file PRIVATE_JSON');
      }
      const callback = wakeupConfig(values['config-file']);
      const fingerprint = createHash('sha256').update(JSON.stringify(callback)).digest('hex');
      const existing = safeWakeupStatus(await call('/bot/doorbell'));
      if (existing.webhook_fingerprint === fingerprint) {
        if (existing.ready) return printWakeupStatus(existing, 'already_verified');
        if (existing.verification_state === 'pending') return printWakeupStatus(existing, 'awaiting_native_acknowledgment');
      }
      await call('/bot/doorbell', { method: 'POST', body: JSON.stringify({ ...callback, test: true }) });
      const status = safeWakeupStatus(await call('/bot/doorbell'));
      if (status.webhook_fingerprint !== fingerprint) throw new CliError('Wake-up configuration changed during setup; inspect wakeup-status before retrying.');
      printWakeupStatus(status, status.ready ? 'verified' : 'awaiting_native_acknowledgment');
      return;
    }
    case 'wakeup-status': {
      if (args.length || Object.entries(values).some(([name, value]) => !['json', 'help', 'test'].includes(name) || name === 'test' && value)) {
        throw new CliError('usage: inbox wakeup-status');
      }
      printWakeupStatus(safeWakeupStatus(await call('/bot/doorbell')), 'observed');
      return;
    }
    case 'acknowledge-wakeup': {
      if (args.length || !values['event-file'] || Object.entries(values).some(([name, value]) => !['event-file', 'json', 'help', 'test'].includes(name) || name === 'test' && value)) {
        throw new CliError('usage: inbox acknowledge-wakeup --event-file PRIVATE_JSON (native routine context only)');
      }
      const event = readWakeupFile(values['event-file']) as { setup_probe?: { token?: unknown } };
      const probe = event && typeof event === 'object' && !Array.isArray(event) ? event.setup_probe?.token : undefined;
      if (typeof probe !== 'string' || probe.length < 24 || probe.length > 512 || !/^[A-Za-z0-9_-]+$/.test(probe)) {
        throw new CliError('Native webhook event has no valid setup_probe.token; do not invent or copy a probe from another run.');
      }
      let alreadyVerified = false;
      try { await call('/bot/doorbell/ack', { method: 'POST', body: JSON.stringify({ probe_token: probe }) }); }
      catch (error) {
        if (!(error instanceof CliError) || !/HTTP (400|409|410)/.test(error.message)) throw error;
        alreadyVerified = true;
      }
      const status = safeWakeupStatus(await call('/bot/doorbell'));
      if (!status.ready) throw new CliError('Native wake-up acknowledgment is not verified; inspect wakeup-status and configure a fresh probe.');
      printWakeupStatus(status, alreadyVerified ? 'already_verified' : 'native_probe_acknowledged');
      return;
    }
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
            ? 'Test ring: HTTP 200. Delivery accepted; automatic wake-up is pending until the native routine acknowledges its probe.'
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
