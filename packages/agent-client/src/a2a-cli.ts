// a2a — a generic A2A v1.0 client for a chat agent's terminal.
// Knows nothing about any particular business: it discovers the agent from a website URL
// (/.well-known/agent-card.json), uses the endpoint the card declares, and sends a bearer
// token only to an endpoint origin it holds a credential for.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Role, TaskState, taskStateToJSON, type AgentCard, type Message, type Part, type Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';

const HELP = `a2a — talk to any A2A v1.0 agent discovered from its website

Usage:
  a2a discover <website-url>                       Fetch and summarize the agent card
  a2a send <website-url> <text> [--task ID] [--data JSON] [--no-wait] [--timeout SEC]
                                                   Send a message; by default wait for the reply
  a2a get <website-url> <task-id>                  Show task state and conversation
  a2a wait <website-url> <task-id> [--timeout SEC] Wait until it is your turn or the task ends
  a2a cancel <website-url> <task-id>               Cancel a task
  a2a login <endpoint-origin>                      Store a token for an endpoint (reads stdin)
  a2a enroll <redeem-url>                          Redeem a one-time enrollment code from the agent's operator

Options:
  --json                 Machine-readable output
  --push-url URL         Ask the agent to POST task updates to this webhook (with --no-wait)
  --push-key-env VAR     Env var holding the webhook's bearer key
Credentials: ${credentialsPath()} (or A2A_CREDENTIALS_FILE). Tokens are never printed.`;

const BLOCKING_BUDGET_MS = Number(process.env.A2A_BLOCKING_MS ?? 110_000);
const OPEN_STATES = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];

function credentialsPath() {
  return process.env.A2A_CREDENTIALS_FILE ?? join(homedir(), '.a2a', 'credentials.json');
}

function loadCredentials(): Record<string, string> {
  const p = credentialsPath();
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

class CliError extends Error {}

/** Finds the agent card advertised by a web page: HTTP `Link` header or `<link rel="agent-card">`. */
async function cardLinkFromPage(pageUrl: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetch(pageUrl, { headers: { accept: 'text/html' }, redirect: 'follow' });
  } catch {
    return undefined;
  }
  const header = res.headers.get('link') ?? '';
  const fromHeader = /<([^>]+)>\s*;[^,]*rel="?agent-card"?/i.exec(header)?.[1];
  if (fromHeader) return new URL(fromHeader, res.url).toString();
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return undefined;
  const html = (await res.text()).slice(0, 200_000);
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/\brel\s*=\s*["']?[^"'>]*\bagent-card\b/i.test(tag)) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (href) return new URL(href, res.url).toString();
    }
  }
  return undefined;
}

async function discover(websiteUrl: string) {
  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    throw new CliError(`Not a URL: ${websiteUrl}`);
  }
  const resolver = new DefaultAgentCardResolver();
  // 1. A2A standard: /.well-known/agent-card.json on the website's own origin.
  let cardUrl = `${origin}/.well-known/agent-card.json`;
  let foundVia = 'well-known URI (A2A standard)';
  let card: AgentCard | undefined;
  let firstError = '';
  try {
    card = await resolver.resolve(origin);
  } catch (err) {
    firstError = (err as Error).message;
  }
  // 2. Convention: the page points at its card (Link header or <link rel="agent-card">).
  if (!card) {
    const linked = await cardLinkFromPage(websiteUrl);
    if (!linked) {
      throw new CliError(
        `No agent card found for ${websiteUrl}: ${firstError}; and the page has no rel="agent-card" link. Not connecting.`,
      );
    }
    try {
      card = await resolver.resolve(linked, '');
    } catch (err) {
      throw new CliError(`The page links to ${linked}, but it is not a usable agent card: ${(err as Error).message}`);
    }
    cardUrl = linked;
    foundVia = 'rel="agent-card" link on the page';
  }
  const iface = (card.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion?.startsWith('1.'));
  if (!iface) {
    const offered = (card.supportedInterfaces ?? []).map((i) => `${i.protocolBinding}@${i.protocolVersion}`).join(', ');
    throw new CliError(`Agent card has no compatible interface (need JSONRPC 1.x; card offers: ${offered || 'none'}).`);
  }
  return { card, cardUrl, foundVia, iface, endpointOrigin: new URL(iface.url).origin };
}

async function connect(websiteUrl: string): Promise<{ client: Client; card: AgentCard; endpoint: string }> {
  const d = await discover(websiteUrl);
  const token = loadCredentials()[d.endpointOrigin];
  if (!token) {
    throw new CliError(
      `No credential for ${d.endpointOrigin} (endpoint from the agent card). Run: a2a login ${d.endpointOrigin}`,
    );
  }
  const authFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.origin === d.endpointOrigin) headers.set('authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
      preferredTransports: ['JSONRPC'],
    }),
  );
  return { client: await factory.createFromAgentCard(d.card), card: d.card, endpoint: d.iface.url };
}

const textOf = (parts: Part[]) =>
  parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : undefined))
    .filter(Boolean)
    .join('\n');
const dataOf = (parts: Part[]) => parts.filter((p) => p.content?.$case === 'data').map((p) => p.content!.value);

function conversation(task: Task): Message[] {
  const msgs = [...(task.history ?? [])];
  const last = task.status?.message;
  if (last && !msgs.some((m) => m.messageId === last.messageId)) msgs.push(last);
  return msgs;
}

function nextStep(task: Task) {
  switch (task.status?.state) {
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return `Your turn. Reply with: a2a send <website-url> "<text>" --task ${task.id}`;
    case TaskState.TASK_STATE_SUBMITTED:
    case TaskState.TASK_STATE_WORKING:
      return `The agent is still working. Run: a2a wait <website-url> ${task.id}`;
    default:
      return 'The task has ended. Start a new task for anything else.';
  }
}

function printTask(task: Task, json: boolean, full = false) {
  if (json) return void console.log(JSON.stringify(task, null, 2));
  const state = taskStateToJSON(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
  console.log(`task:  ${task.id}`);
  console.log(`state: ${state}`);
  const msgs = conversation(task);
  const shown = full ? msgs : msgs.filter((m) => m.role === Role.ROLE_AGENT).slice(-1);
  for (const m of shown) {
    const who = m.role === Role.ROLE_AGENT ? 'agent' : 'you';
    console.log(`\n[${who}] ${textOf(m.parts)}`);
    for (const d of dataOf(m.parts)) console.log(`[${who} data] ${JSON.stringify(d)}`);
  }
  for (const a of task.artifacts ?? []) {
    console.log(`\n[artifact ${a.name}] ${textOf(a.parts)}`);
    for (const d of dataOf(a.parts)) console.log(`[artifact data] ${JSON.stringify(d)}`);
  }
  console.log(`\nnext: ${nextStep(task)}`);
}

async function waitForTurn(client: Client, taskId: string, timeoutMs: number): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  let task = await client.getTask({ id: taskId, tenant: '', historyLength: undefined });
  while (OPEN_STATES.includes(task.status?.state as TaskState) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    task = await client.getTask({ id: taskId, tenant: '', historyLength: undefined });
  }
  return task;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      data: { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
      timeout: { type: 'string' },
      json: { type: 'boolean', default: false },
      'push-url': { type: 'string' },
      'push-key-env': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...args] = positionals;
  const json = values.json!;
  const timeoutMs = Number(values.timeout ?? 600) * 1000;
  if (!cmd || values.help) return void console.log(HELP);

  switch (cmd) {
    case 'discover': {
      const [url] = args;
      if (!url) throw new CliError('usage: a2a discover <website-url>');
      const d = await discover(url);
      if (json) return void console.log(JSON.stringify(d.card, null, 2));
      const c = d.card;
      console.log(`agent:      ${c.name} (v${c.version})`);
      console.log(`card:       ${d.cardUrl}`);
      console.log(`found via:  ${d.foundVia}`);
      console.log(`provider:   ${c.provider?.organization ?? '-'}`);
      console.log(`about:      ${c.description}`);
      console.log(`endpoint:   ${d.iface.url}  [${d.iface.protocolBinding}, A2A ${d.iface.protocolVersion}]`);
      console.log(`auth:       ${Object.keys(c.securitySchemes ?? {}).join(', ') || 'none declared'}`);
      console.log(`streaming:  ${!!c.capabilities?.streaming}   push: ${!!c.capabilities?.pushNotifications}`);
      for (const s of c.skills ?? []) console.log(`skill:      ${s.id} — ${s.description}`);
      console.log(`credential: ${loadCredentials()[d.endpointOrigin] ? 'present' : 'MISSING'} for ${d.endpointOrigin}`);
      return;
    }
    case 'send': {
      const [url, ...words] = args;
      const text = words.join(' ').trim();
      if (!url || !text) throw new CliError('usage: a2a send <website-url> <text> [--task ID]');
      const { client, card } = await connect(url);
      const parts: Part[] = [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }];
      if (values.data) {
        let data: unknown;
        try {
          data = JSON.parse(values.data);
        } catch {
          throw new CliError('--data must be valid JSON');
        }
        parts.push({ content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: 'application/json' });
      }
      let push;
      if (values['push-url']) {
        if (!card.capabilities?.pushNotifications) throw new CliError('This agent does not declare push notification support.');
        const keyVar = values['push-key-env'];
        const key = keyVar ? process.env[keyVar] : undefined;
        if (keyVar && !key) throw new CliError(`Env var ${keyVar} is empty`);
        push = {
          id: '',
          taskId: '',
          tenant: '',
          url: values['push-url'],
          token: '',
          authentication: key ? { scheme: 'Bearer', credentials: key } : undefined,
        };
      }
      const noWait = values['no-wait']! || !!push;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), BLOCKING_BUDGET_MS);
      const messageId = randomUUID();
      let result;
      try {
        result = await client.sendMessage(
          {
            tenant: '',
            metadata: {},
            message: {
              messageId,
              role: Role.ROLE_USER,
              parts,
              taskId: values.task ?? '',
              contextId: '',
              extensions: [],
              metadata: {},
              referenceTaskIds: [],
            },
            configuration: {
              acceptedOutputModes: ['text/plain', 'application/json'],
              returnImmediately: noWait,
              taskPushNotificationConfig: push,
              historyLength: undefined,
            },
          },
          { signal: ac.signal },
        );
      } catch (err) {
        if (!ac.signal.aborted) throw err;
        // Blocking budget used up: the agent keeps working server-side; switch to polling.
        if (!values.task) {
          throw new CliError(
            'The agent is taking long and the new task id was not returned yet. Re-run with --no-wait to get the id immediately.',
          );
        }
        result = await waitForTurn(client, values.task, timeoutMs);
      } finally {
        clearTimeout(timer);
      }
      if (!('id' in result)) {
        if (json) return void console.log(JSON.stringify(result, null, 2));
        console.log(`[agent] ${textOf(result.parts)}`);
        return;
      }
      let task = result as Task;
      if (!noWait && OPEN_STATES.includes(task.status?.state as TaskState)) task = await waitForTurn(client, task.id, timeoutMs);
      printTask(task, json);
      return;
    }
    case 'get':
    case 'wait':
    case 'cancel': {
      const [url, taskId] = args;
      if (!url || !taskId) throw new CliError(`usage: a2a ${cmd} <website-url> <task-id>`);
      const { client } = await connect(url);
      const task =
        cmd === 'get'
          ? await client.getTask({ id: taskId, tenant: '', historyLength: undefined })
          : cmd === 'wait'
            ? await waitForTurn(client, taskId, timeoutMs)
            : await client.cancelTask({ id: taskId, tenant: '', metadata: {} });
      printTask(task, json, cmd === 'get');
      return;
    }
    case 'enroll': {
      const [redeemUrl] = args;
      if (!redeemUrl) throw new CliError('usage: a2a enroll <redeem-url>');
      const res = await fetch(redeemUrl, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new CliError(`${res.status}: ${body.error ?? res.statusText}`);
      if (body.role !== 'customer') throw new CliError(`This code is for role ${body.role}, not customer.`);
      const o = new URL(body.url).origin;
      const p = credentialsPath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ ...loadCredentials(), [o]: body.token }, null, 2));
      chmodSync(p, 0o600);
      console.log(`Enrolled as ${body.id} for ${o}. Token saved to ${p} (not shown).`);
      return;
    }
    case 'login': {
      const [origin] = args;
      if (!origin) throw new CliError('usage: echo "$TOKEN" | a2a login <endpoint-origin>');
      const o = new URL(origin).origin;
      const token = readFileSync(0, 'utf8').trim();
      if (!token) throw new CliError('No token on stdin.');
      const p = credentialsPath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ ...loadCredentials(), [o]: token }, null, 2));
      chmodSync(p, 0o600);
      console.log(`Stored credential for ${o} in ${p}`);
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
