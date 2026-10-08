import { readFileSync } from 'node:fs';
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
  registry --url https://registry.example search [--service ID] [--action book] [--lat N --lon N --radius-km N] [--limit N --offset N]
  registry --url https://registry.example get BUSINESS_ID
  registry --url https://registry.example mine
  registry --url https://registry.example register --data-file business.json
  registry --url https://registry.example update BUSINESS_ID --data-file changes.json
  registry --url https://registry.example verify|check|pause BUSINESS_ID

REGISTRY_URL may supply the registry origin. REGISTRY_TOKEN is required only for publisher operations.
Use --allow-http-localhost only for local tests. Tokens are never sent on public search/get requests.
Registration requires publishing the returned challenge on the business website before verification.
`;

export async function registryMain(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    url: { type: 'string' }, 'data-file': { type: 'string' }, 'allow-http-localhost': { type: 'boolean' },
    service: { type: 'string' }, action: { type: 'string' }, lat: { type: 'string' }, lon: { type: 'string' },
    'radius-km': { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const [name, id] = positionals;
  if (name === 'tools') {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error('tools accepts no arguments or flags');
    process.stdout.write(JSON.stringify({ commands: REGISTRY_COMMANDS }, null, 2) + '\n'); return;
  }
  const command = REGISTRY_COMMANDS.find(value => value.name === name);
  if (!command) throw new Error(`Unknown command ${name}`);
  const hasId = command.path.includes(':id');
  if (positionals.length !== (hasId ? 2 : 1) || (hasId && !/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? ''))) throw new Error('Invalid command arguments or business ID');
  const filters = ['service', 'action', 'lat', 'lon', 'radius-km', 'limit', 'offset'] as const;
  if (name !== 'search' && filters.some(key => values[key] !== undefined)) throw new Error('Search filters require the search command');
  const needsFile = name === 'register' || name === 'update';
  if (needsFile !== Boolean(values['data-file'])) throw new Error(needsFile ? '--data-file is required' : '--data-file is not supported for this command');
  const base = new URL(values.url ?? env.REGISTRY_URL ?? '');
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Registry URL must be an origin without credentials, path, query or fragment');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && values['allow-http-localhost'] && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('HTTPS is required; local HTTP needs --allow-http-localhost');
  const target = new URL(command.path.replace(':id', encodeURIComponent(id ?? '')), base);
  for (const key of filters) if (values[key] !== undefined) target.searchParams.set(key === 'radius-km' ? 'radius_km' : key, values[key]!);
  const token = command.authenticated ? env.REGISTRY_TOKEN : undefined;
  if (command.authenticated && (!token || /\s/.test(token))) throw new Error('REGISTRY_TOKEN is required and must contain no whitespace');
  let body: string | undefined;
  if (values['data-file']) {
    body = readFileSync(values['data-file'], 'utf8');
    if (Buffer.byteLength(body) > 32_000) throw new Error('Listing payload exceeds 32 KB');
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Listing payload must be a JSON object');
  }
  const response = await fetch(target, { method: command.method, body, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } });
  let output = await response.text();
  if (env.REGISTRY_TOKEN) output = output.split(env.REGISTRY_TOKEN).join('[REDACTED]');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${output}`);
  process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) registryMain(process.argv.slice(2)).catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  if (process.env.REGISTRY_TOKEN) message = message.split(process.env.REGISTRY_TOKEN).join('[REDACTED]');
  process.stderr.write(message + '\n'); process.exitCode = 1;
});
