import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const REGISTRY_COMMANDS = [
  { name: 'search', method: 'GET', path: '/api/search', authenticated: false, description: 'Find active businesses by service, declared action and location.' },
  { name: 'get', method: 'GET', path: '/api/businesses/:id', authenticated: false, description: 'Read an active public listing.' },
  { name: 'mine', method: 'GET', path: '/api/me/businesses', authenticated: true, description: 'List your listings, including pending and paused entries and verification challenges.' },
  { name: 'register', method: 'POST', path: '/api/businesses', authenticated: true, description: 'Create a pending listing from --data-file; registration alone does not publish it.' },
  { name: 'update', method: 'PATCH', path: '/api/businesses/:id', authenticated: true, description: 'Update your listing from --data-file; edits require verification again.' },
  { name: 'verify', method: 'POST', path: '/api/businesses/:id/verify', authenticated: true, description: 'Check the published website challenge and Agent Card, then activate your listing.' },
  { name: 'check', method: 'POST', path: '/api/businesses/:id/check', authenticated: true, description: 'Refresh metadata health; does not resume paused listings.' },
  { name: 'pause', method: 'POST', path: '/api/businesses/:id/pause', authenticated: true, description: 'Hide your business from public discovery.' },
] as const;

const help = `Business registry client
Usage:
  registry tools
  registry enroll REDEEM_URL
  registry --url https://registry.example search [--service ID] [--action book] [--q "Holešovice"] [--lat N --lon N --radius-km N] [--limit N --offset N]
  registry --url https://registry.example get BUSINESS_ID
  registry --url https://registry.example mine
  registry --url https://registry.example register --data-file business.json
  registry --url https://registry.example update BUSINESS_ID --data-file changes.json
  registry --url https://registry.example verify|check|pause BUSINESS_ID

Enroll with an operator-issued one-time HTTPS URL to save a publisher credential locally.
REGISTRY_CONFIG overrides ~/.a2a/registry.json. REGISTRY_URL and REGISTRY_TOKEN override saved values.
A publisher credential is required only for publisher operations; enrollment never prints it.
Use --allow-http-localhost only for local tests. Tokens are never sent on public search/get requests.
Registration requires publishing the returned challenge on the business website before verification.
`;

function secureUrl(value: string, allowLocal: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid registry URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Registry URL cannot contain credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('HTTPS is required; local HTTP needs --allow-http-localhost');
  return url;
}

export async function registryMain(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    url: { type: 'string' }, 'data-file': { type: 'string' }, 'allow-http-localhost': { type: 'boolean' },
    service: { type: 'string' }, action: { type: 'string' }, q: { type: 'string' }, lat: { type: 'string' }, lon: { type: 'string' },
    'radius-km': { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const [name, id] = positionals;
  if (name === 'tools') {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error('tools accepts no arguments or flags');
    process.stdout.write(JSON.stringify({ commands: REGISTRY_COMMANDS }, null, 2) + '\n'); return;
  }
  const configPath = env.REGISTRY_CONFIG ?? join(homedir(), '.a2a', 'registry.json');
  if (name === 'enroll') {
    if (positionals.length !== 2 || Object.keys(values).some(key => key !== 'allow-http-localhost')) throw new Error('enroll requires only a redemption URL');
    const target = secureUrl(id ?? '', Boolean(values['allow-http-localhost']));
    if (!/^\/publisher-enrollments\/[A-Za-z0-9_-]{43}$/.test(target.pathname)) throw new Error('Invalid enrollment URL');
    // Enrollment response and transport failures may contain credentials or the one-time code.
    try {
      const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      const saved = data as Record<string, unknown>;
      if (saved.role !== 'publisher' || typeof saved.registry_url !== 'string' || typeof saved.token !== 'string' || !/^publisher_[A-Za-z0-9_-]{43}$/.test(saved.token)) throw new Error();
      const registry = secureUrl(saved.registry_url, Boolean(values['allow-http-localhost']));
      if (registry.pathname !== '/' || registry.origin !== target.origin) throw new Error();
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      const temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ registry_url: registry.origin, token: saved.token }) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, configPath);
      } finally { rmSync(temporary, { force: true }); }
    } catch { throw new Error('Publisher enrollment failed; check the URL, expiry and local credential storage'); }
    process.stdout.write('Publisher credential saved. Run registry mine to check your listings.\n'); return;
  }
  const command = REGISTRY_COMMANDS.find(value => value.name === name);
  if (!command) throw new Error(`Unknown command ${name}`);
  const hasId = command.path.includes(':id');
  if (positionals.length !== (hasId ? 2 : 1) || (hasId && !/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? ''))) throw new Error('Invalid command arguments or business ID');
  const filters = ['service', 'action', 'q', 'lat', 'lon', 'radius-km', 'limit', 'offset'] as const;
  if (name !== 'search' && filters.some(key => values[key] !== undefined)) throw new Error('Search filters require the search command');
  const needsFile = name === 'register' || name === 'update';
  if (needsFile !== Boolean(values['data-file'])) throw new Error(needsFile ? '--data-file is required' : '--data-file is not supported for this command');
  let saved: { registry_url?: string; token?: string } = {};
  try {
    const data: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const candidate = data as Record<string, unknown>;
    if (typeof candidate.registry_url !== 'string' || typeof candidate.token !== 'string') throw new Error();
    saved = { registry_url: candidate.registry_url, token: candidate.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !((values.url || env.REGISTRY_URL) && (!command.authenticated || env.REGISTRY_TOKEN))) throw new Error('Cannot read registry credential configuration');
  }
  const base = secureUrl(values.url ?? env.REGISTRY_URL ?? saved.registry_url ?? '', Boolean(values['allow-http-localhost']));
  if (base.pathname !== '/') throw new Error('Registry URL must be an origin without path');
  const target = new URL(command.path.replace(':id', encodeURIComponent(id ?? '')), base);
  for (const key of filters) if (values[key] !== undefined) target.searchParams.set(key === 'radius-km' ? 'radius_km' : key, values[key]!);
  const token = command.authenticated ? env.REGISTRY_TOKEN ?? saved.token : undefined;
  if (command.authenticated && token && !env.REGISTRY_TOKEN && saved.registry_url && base.origin !== new URL(saved.registry_url).origin) throw new Error('Saved publisher credential belongs to another registry; enroll there or provide REGISTRY_TOKEN');
  if (command.authenticated && (!token || /\s/.test(token))) throw new Error('REGISTRY_TOKEN is required and must contain no whitespace');
  let body: string | undefined;
  if (values['data-file']) {
    body = readFileSync(values['data-file'], 'utf8');
    if (Buffer.byteLength(body) > 32_000) throw new Error('Listing payload exceeds 32 KB');
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Listing payload must be a JSON object');
  }
  try {
    const response = await fetch(target, { method: command.method, body, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } });
    let output = await response.text();
    for (const secret of [env.REGISTRY_TOKEN, saved.token]) if (secret) output = output.split(secret).join('[REDACTED]');
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${output}`);
    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Registry request failed';
    for (const secret of [env.REGISTRY_TOKEN, saved.token]) if (secret) message = message.split(secret).join('[REDACTED]');
    throw new Error(message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) registryMain(process.argv.slice(2)).catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  if (process.env.REGISTRY_TOKEN) message = message.split(process.env.REGISTRY_TOKEN).join('[REDACTED]');
  process.stderr.write(message + '\n'); process.exitCode = 1;
});
