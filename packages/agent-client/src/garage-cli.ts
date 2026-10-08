// Private legacy tools. Customer-facing conversation uses the separate A2A client.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GARAGE_TOOLS, namedGarageRequest } from './garage-tools.js';

const help = `Pneu 007 private HTTP tools
Usage: garage tools
       garage enroll REDEEM_URL
       garage --url https://your-business.example COMMAND [ID] [OPTIONS]
       garage --url https://your-business.example call METHOD /api/path [--data-file request.json]
Commands: ${GARAGE_TOOLS.map(tool => tool.name).join(', ')}
Run 'garage tools' for machine-readable command descriptions and arguments.
Options: --allow-http-localhost permits HTTP only for localhost, 127.0.0.1 or [::1].
Credentials: PNEU007_TOOL_TOKEN or locally enrolled ~/.a2a/garage.json (never printed).
PNEU007_BUSINESS_URL sets the default origin. GARAGE_CONFIG overrides the local config path.
This CLI does not send A2A messages, perform an audit, or generate a rulebook for the bot.
`;

type GarageConfig = { role: 'business_agent'; url: string; token: string };
function origin(value: string, allowLocal: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--url must be an origin without credentials, path, query or fragment');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowLocal)) {
    throw new Error('HTTPS is required; local HTTP needs --allow-http-localhost');
  }
  return url;
}
function configFile(env: NodeJS.ProcessEnv): string { return env.GARAGE_CONFIG ?? join(homedir(), '.a2a', 'garage.json'); }
function readConfig(env: NodeJS.ProcessEnv): GarageConfig | undefined {
  const file = configFile(env);
  if (!existsSync(file)) return;
  try {
    const config: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    const value = config as Partial<GarageConfig>;
    if (value.role !== 'business_agent' || typeof value.url !== 'string' || typeof value.token !== 'string'
      || value.token.length < 24 || /[\r\n]/.test(value.token)) throw new Error();
    return { role: value.role, url: value.url, token: value.token };
  } catch { throw new Error('Invalid local garage configuration; enroll again.'); }
}
async function enroll(redeemUrl: string, env: NodeJS.ProcessEnv, allowLocal: boolean): Promise<void> {
  let target: URL;
  try { target = new URL(redeemUrl); } catch { throw new Error('Invalid enrollment URL'); }
  origin(target.origin, allowLocal);
  if (target.username || target.password || target.search || target.hash || !/^\/agent-enrollments\/[A-Za-z0-9_-]{43}$/.test(target.pathname)) {
    throw new Error('Invalid enrollment URL');
  }
  let config: GarageConfig;
  try {
    const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const data = value as Partial<GarageConfig>;
    if (data.role !== 'business_agent' || typeof data.url !== 'string' || origin(data.url, allowLocal).origin !== target.origin
      || typeof data.token !== 'string' || data.token.length < 24 || data.token.length > 4096 || /[\r\n]/.test(data.token)) throw new Error();
    config = { role: data.role, url: target.origin, token: data.token };
  } catch { throw new Error('Enrollment failed; obtain a fresh one-time link from the business owner.'); }
  const file = configFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  process.stdout.write('Business tools enrolled. Credentials saved locally.\n');
}

export async function garageMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let base = '', dataFile: string | undefined, allowLocal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (['--url', '--data-file', '--datafile', '--service', '--from', '--to', '--status', '--job'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--url') { if (base) throw new Error('Specify --url once'); base = value; }
      else {
        const name = arg === '--datafile' ? '--data-file' : arg;
        if (options.has(name)) throw new Error(`Specify ${name} once`);
        options.set(name, value);
        if (name === '--data-file') dataFile = value;
      }
    } else if (arg === '--allow-http-localhost') allowLocal = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positionals.push(arg);
  }
  if (positionals[0] === 'tools') {
    if (positionals.length !== 1 || options.size || base || allowLocal) throw new Error('tools does not accept arguments or options');
    process.stdout.write(JSON.stringify({ tools: GARAGE_TOOLS }, null, 2) + '\n');
    return;
  }
  if (positionals[0] === 'enroll') {
    if (positionals.length !== 2 || options.size || base) throw new Error('Usage: garage enroll REDEEM_URL');
    await enroll(positionals[1]!, env, allowLocal);
    return;
  }
  base ||= env.PNEU007_BUSINESS_URL ?? '';
  const config = !base || !env.PNEU007_TOOL_TOKEN ? readConfig(env) : undefined;
  base ||= config?.url ?? '';
  if (!base || !positionals.length) throw new Error(help.trim());
  let method: string, path: string;
  if (positionals[0] === 'call') {
    if (positionals.length !== 3) throw new Error(help.trim());
    for (const option of options.keys()) if (option !== '--data-file') throw new Error(`${option} is not supported by call`);
    method = positionals[1]!.toUpperCase();
    path = positionals[2]!;
  } else ({ method, path } = namedGarageRequest(positionals, options));
  const url = origin(base, allowLocal);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new Error('PATH must be an absolute path on the explicitly configured origin');
  }
  const target = new URL(path, url);
  if (target.origin !== url.origin) throw new Error('Cannot send credentials to another origin');
  const token = env.PNEU007_TOOL_TOKEN ?? (config && origin(config.url, allowLocal).origin === url.origin ? config.token : undefined);
  if (!token || /[\r\n]/.test(token)) throw new Error('PNEU007_TOOL_TOKEN is required');
  if (method === 'GET' && dataFile) throw new Error('GET cannot have request data');
  const body = dataFile === undefined ? undefined : readFileSync(dataFile, 'utf8');
  if (body !== undefined) {
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('Request data exceeds 1 MB');
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new Error('Request data must be valid JSON'); }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Request data must be a JSON object');
  }
  const response = await fetch(target, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body,
  });
  const output = (await response.text()).split(token).join('[REDACTED]');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${output}`);
  process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  garageMain(process.argv.slice(2)).catch(error => {
    const token = process.env.PNEU007_TOOL_TOKEN;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write((token ? message.split(token).join('[REDACTED]') : message) + '\n');
    process.exitCode = 1;
  });
}
