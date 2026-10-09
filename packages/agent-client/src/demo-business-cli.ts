// Public tools for the prepared fictional shop. No login, enrollment or bearer credential.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { grokRoutineLinks, parseGrokKeySettingsLink, grokWebhookHandoff } from './grok-routine-links.js';

type LocalConfig = { url: string; leases: Record<string, { lease_token: string; claim_generation: number }> };
const help = `Open business demo: no account, approval code or ownership proof.
demo-business connect --url WEBSITE
demo-business profile | catalog | rulebook | cases | reservations | inbox | availability
demo-business schedule [--service tyre_change] [--from ISO --to ISO]
demo-business case CASE_ID | order ORDER_ID
demo-business quote CASE_ID --data-file quote.json
demo-business reply WORK_ITEM_ID --data-file reply.json
demo-business scheduled-check-in [--interval 60]
demo-business routine-links --routine-id ACTUAL_LOCAL_ROUTINE_ID [--agent-id ACTUAL_BOT_ID]
demo-business webhook-setup --routine-id ACTUAL_LOCAL_ROUTINE_ID [--agent-id ACTUAL_BOT_ID] [--callback-url ACTUAL_CALLBACK]
                             Or supply --key-settings-url ACTUAL_ROUTINE_SPECIFIC_KEY_LINK
demo-business set-webhook --callback-url ACTUAL_ROUTINE_URL --key-env ACTUAL_RUNTIME_SECRET_ENV
demo-business wakeup-status
demo-business acknowledge-wakeup --event-file PRIVATE_EVENT_JSON (native routine only)
DEMO_BUSINESS_CONFIG selects the local demo configuration; all commands return private working JSON.
Webhook setup uses Grok’s native masked secret input. The actual native handler acknowledges its setup event, processes the inbox and exits.`;

export async function demoBusinessMain(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: 'string' }, 'data-file': { type: 'string' }, interval: { type: 'string' },
    service: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    'callback-url': { type: 'string' }, 'key-settings-url': { type: 'string' }, 'event-file': { type: 'string' }, 'key-env': { type: 'string' }, 'key-file': { type: 'string' },
    'agent-id': { type: 'string' }, 'routine-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  const [command, id] = positionals;
  if (!command || values.help) return void console.log(help);
  const path = process.env.DEMO_BUSINESS_CONFIG ?? join(homedir(), '.a2a', 'demo-business.json');
  let config: LocalConfig = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { url: '', leases: {} };
  const supplied = values.url ?? config.url;
  let origin: URL;
  try { origin = new URL(supplied); } catch { throw new Error('Connect with --url WEBSITE first.'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Use an HTTPS website origin (HTTP is allowed only on localhost).');
  if (config.url && config.url !== origin.origin) throw new Error('Select a separate DEMO_BUSINESS_CONFIG for another site.');
  config = { url: origin.origin, leases: config.leases ?? {} };
  const save = () => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); chmodSync(path, 0o600); };
  const secrets: string[] = [];
  const safe = (value: unknown) => JSON.stringify(value, (_name, value) => typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value) : value, 2);
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(config.url + '/demo-business' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data: any;
    try { data = await response.json(); } catch { throw new Error('The demo service returned an invalid response.'); }
    if (!response.ok) throw new Error(`Demo operation failed (${response.status}): ${safe(data)}`);
    return data;
  };
  let body: any;
  if (values['data-file']) {
    const raw = readFileSync(values['data-file'], 'utf8');
    if (Buffer.byteLength(raw) > 32000) throw new Error('Demo input too large.');
    body = JSON.parse(raw);
  }
  let result: any;
  if (command === 'connect') {
    result = await request('/connect', {});
    if (result.mode !== 'open_demo' || result.authentication !== 'none') throw new Error('This site has not enabled open demo setup.');
    save();
  } else if (['case', 'order', 'quote', 'reply'].includes(command)) {
    if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('Supply the demo case, order or work-item ID.');
    if (command === 'reply') {
      const lease = config.leases[id];
      if (!lease || !body || typeof body.text !== 'string') throw new Error('Read the inbox first, then provide a reply JSON file with text and state.');
      result = await request('/bot/reply', { ...body, work_item_id: id, ...lease });
      delete config.leases[id]; save();
    } else {
      if (command === 'quote' && !body) throw new Error('Quote requires --data-file with slot_id and discount_bps.');
      result = await request(command === 'order' ? `/orders/${id}` : `/cases/${id}${command === 'quote' ? '/quotes' : ''}`, command === 'quote' ? body : undefined);
    }
  } else if (command === 'routine-links') {
    if (!values['routine-id']) throw new Error('Obtain the actual local routine ID from Grok.');
    result = grokRoutineLinks(values['agent-id'], values['routine-id']);
  } else if (command === 'webhook-setup') {
    if (values['agent-id'] && !values['routine-id']) throw new Error('Supply the actual local routine ID.');
    const fromIds = values['routine-id'] ? grokRoutineLinks(values['agent-id'], values['routine-id']) : undefined;
    const suppliedLink = values['key-settings-url'] ? parseGrokKeySettingsLink(values['key-settings-url']) : undefined;
    if (!fromIds && !suppliedLink) throw new Error('Obtain the local routine ID or a routine-specific webhook-key link.');
    if (fromIds && suppliedLink && (fromIds.routine_id !== suppliedLink.routine_id || fromIds.agent_id && suppliedLink.agent_id && fromIds.agent_id !== suppliedLink.agent_id)) throw new Error('The key link points to a different bot or routine.');
    result = grokWebhookHandoff({ routine_id: (fromIds ?? suppliedLink)!.routine_id, agent_id: fromIds?.agent_id ?? suppliedLink?.agent_id, callback_url: values['callback-url'] });
  } else if (command === 'set-webhook') {
    if (!values['callback-url'] || Boolean(values['key-env']) === Boolean(values['key-file'])) throw new Error('Supply the real callback URL and exactly one runtime secret binding: --key-env NAME or --key-file PRIVATE_PATH.');
    const callback = new URL(values['callback-url']);
    if (callback.username || callback.password || callback.hash || (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost','127.0.0.1'].includes(callback.hostname)))) throw new Error('Invalid routine callback URL.');
    let key: string;
    try {
      if (values['key-env']) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(values['key-env'])) throw new Error();
        key = process.env[values['key-env']] ?? '';
      } else {
        const stat = lstatSync(values['key-file']!);
        if (!stat.isFile() || stat.size > 514 || stat.mode & 0o077) throw new Error();
        key = readFileSync(values['key-file']!, 'utf8');
      }
      key = key.trim();
      if (key.length < 8 || key.length > 512 || /[\r\n\0]/.test(key)) throw new Error();
    } catch { throw new Error('The secure webhook key is unavailable. Use the actual secret binding returned by Grok’s masked input; never paste it into ordinary chat or command arguments.'); }
    secrets.push(key);
    result = await request('/bot/doorbell', { url: callback.href, key, test: true });
  } else if (command === 'wakeup-status') {
    result = await request('/bot/doorbell');
  } else if (command === 'acknowledge-wakeup') {
    if (!values['event-file']) throw new Error('The actual native routine must supply its private webhook event file.');
    let token: unknown;
    try {
      const stat = lstatSync(values['event-file']);
      if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077) throw new Error();
      token = JSON.parse(readFileSync(values['event-file'], 'utf8'))?.setup_probe?.token;
    } catch { throw new Error('Save the actual webhook body in a private regular JSON file (mode 0600, at most 16 KiB).'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,512}$/.test(token)) throw new Error('The actual webhook event has no valid setup challenge.');
    secrets.push(token);
    try { await request('/bot/doorbell/ack', { probe_token: token }); }
    catch (error) { if (!(error instanceof Error) || !/^Demo operation failed \((400|409|410)\)/.test(error.message)) throw error; }
    result = await request('/bot/doorbell');
    if (result.ready !== true) throw new Error('The native wake-up test has not verified.');
  } else if (command === 'scheduled-check-in') {
    const interval = Number(values.interval ?? 60);
    if (!Number.isSafeInteger(interval) || interval < 60 || interval > 300) throw new Error('Use an actual native schedule interval from 60 to 300 seconds.');
    result = await request('/bot/scheduled-check-in', { interval_seconds: interval });
  } else if (command === 'schedule') {
    const query = new URLSearchParams();
    for (const [key, value] of [['service_id', values.service], ['from', values.from], ['to', values.to]]) if (value) query.set(key!, value);
    result = await request('/schedule' + (query.size ? '?' + query : ''));
  } else if (['profile', 'catalog', 'rulebook', 'cases', 'reservations', 'inbox', 'availability'].includes(command)) {
    result = await request((command === 'inbox' || command === 'availability' ? '/bot/' : '/') + command);
    if (command === 'inbox') {
      for (const item of result.items ?? []) if (typeof item.lease_token === 'string' && Number.isSafeInteger(item.claim_generation)) config.leases[item.work_item_id] = { lease_token: item.lease_token, claim_generation: item.claim_generation };
      save();
    }
  } else throw new Error('Unknown demo command. Use --help.');
  console.log(safe(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) demoBusinessMain().catch(error => { console.error(error.message); process.exitCode = 1; });
