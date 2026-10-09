// Public tools for the prepared fictional shop. No login, enrollment or bearer credential.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

type LocalConfig = { url: string; leases: Record<string, { lease_token: string; claim_generation: number }> };
const help = `Open business demo: no account, approval code, ownership proof or webhook key.
demo-business connect --url WEBSITE
demo-business profile | catalog | rulebook | cases | reservations | inbox | availability
demo-business schedule [--service tyre_change] [--from ISO --to ISO]
demo-business case CASE_ID | order ORDER_ID
demo-business quote CASE_ID --data-file quote.json
demo-business reply WORK_ITEM_ID --data-file reply.json
demo-business scheduled-check-in [--interval 60]
DEMO_BUSINESS_CONFIG selects the local demo configuration; all commands return private working JSON.
The actual native recurring routine must call scheduled-check-in, process the inbox and exit.`;

export async function demoBusinessMain(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: 'string' }, 'data-file': { type: 'string' }, interval: { type: 'string' },
    service: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
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
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(config.url + '/demo-business' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`Demo operation failed (${response.status}): ${JSON.stringify(data)}`);
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
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) demoBusinessMain().catch(error => { console.error(error.message); process.exitCode = 1; });
