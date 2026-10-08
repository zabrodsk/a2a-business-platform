// inbox — the Business agent's side of the relay. Private API, NOT A2A.
// Config: RELAY_URL and RELAY_TOKEN env vars, or ~/.a2a/inbox.json {"url": "...", "token": "..."}.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `inbox — pending customer conversations for the business agent

Usage:
  inbox enroll <redeem-url>           One-time setup: redeem an enrollment code, save the token locally
  inbox read                          Claim and show all pending work items
  inbox wait [--timeout SEC]          Block until work arrives (default 50 s, max 55), then show it
  inbox watch [--minutes N]           Repeat 'wait' for N minutes (default 20); prints items as they come
  inbox reply <work-item-id> <text> [--state input-required|completed|rejected] [--data JSON]
  inbox show <task-id>                Show a task's full conversation
  inbox set-doorbell <webhook-url> --key KEY [--test]
                                      Register your wake-up webhook (e.g. a routine's webhook trigger).
                                      The relay POSTs to it with "Authorization: Bearer KEY" when work arrives.
                                      --test rings it once right away. The key can also come from stdin.
  inbox clear-doorbell                Stop the relay from ringing your webhook

Each work item is one customer message waiting for your answer. Answer every item exactly once.
--state input-required (default) hands the turn back to the customer; completed/rejected ends the task.
Config: RELAY_URL + RELAY_TOKEN, or ~/.a2a/inbox.json. The token is never printed.`;

class CliError extends Error {}

const configFile = () => process.env.INBOX_CONFIG ?? join(homedir(), '.a2a', 'inbox.json');

function config() {
  let url = process.env.RELAY_URL;
  let token = process.env.RELAY_TOKEN;
  const file = configFile();
  if ((!url || !token) && existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    url ||= c.url;
    token ||= c.token;
  }
  if (!url || !token) throw new CliError(`Set RELAY_URL and RELAY_TOKEN, or create ${file}`);
  return { url: url.replace(/\/$/, ''), token };
}

async function call(path: string, init: RequestInit = {}) {
  const { url, token } = config();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(`${res.status}: ${body.error ?? res.statusText}`);
  return body;
}

interface Item {
  work_item_id: string;
  task_id: string;
  customer: string;
  turn: number;
  max_turns: number;
  history: Array<{ from: string; text: string; data?: unknown }>;
}

function printItems(items: Item[], json: boolean) {
  if (json) return void console.log(JSON.stringify(items, null, 2));
  if (!items.length) return void console.log('No pending work.');
  for (const it of items) {
    console.log(`=== work item ${it.work_item_id}`);
    console.log(`task ${it.task_id} · customer ${it.customer} · your reply is turn ${it.turn}/${it.max_turns}`);
    for (const m of it.history) {
      console.log(`[${m.from}] ${m.text}`);
      if (m.data !== undefined) console.log(`[${m.from} data] ${JSON.stringify(m.data)}`);
    }
    console.log(`→ inbox reply ${it.work_item_id} "<your answer>" [--state input-required|completed|rejected]\n`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: 'string' },
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
    case 'enroll': {
      const [redeemUrl] = args;
      if (!redeemUrl) throw new CliError('usage: inbox enroll <redeem-url>');
      const res = await fetch(redeemUrl, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new CliError(`${res.status}: ${body.error ?? res.statusText}`);
      if (body.role !== 'business') throw new CliError(`This code is for role ${body.role}, not business.`);
      const file = configFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ url: body.url, token: body.token }, null, 2), { mode: 0o600 });
      chmodSync(file, 0o600);
      console.log(`Enrolled as ${body.id} (${body.role}) at ${body.url}. Token saved to ${file} (not shown).`);
      return;
    }
    case 'read':
      return printItems((await call('/bot/inbox')).items, json);
    case 'wait':
      return printItems((await call(`/bot/wait?timeout=${Number(values.timeout ?? 50)}`)).items, json);
    case 'watch': {
      const until = Date.now() + Number(values.minutes ?? 20) * 60_000;
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
      const r = await call('/bot/reply', {
        method: 'POST',
        body: JSON.stringify({ work_item_id: id, text, data, state: values.state ?? 'input-required' }),
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
            : `Test ring failed: ${r.test_ring.status ?? ''} ${r.test_ring.error ?? ''}`.trim(),
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

main().catch((err) => {
  console.error(`error: ${err instanceof CliError ? err.message : (err?.message ?? err)}`);
  process.exit(1);
});
