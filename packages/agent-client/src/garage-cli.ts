// Private legacy tools. Customer-facing conversation uses the separate A2A client.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GARAGE_TOOLS, namedGarageRequest } from './garage-tools.js';

const help = `Pneu 007 private HTTP tools
Usage: garage tools
       garage --url https://your-business.example COMMAND [ID] [OPTIONS]
       garage --url https://your-business.example call METHOD /api/path [--data-file request.json]
Commands: ${GARAGE_TOOLS.map(tool => tool.name).join(', ')}
Run 'garage tools' for machine-readable command descriptions and arguments.
Options: --allow-http-localhost permits HTTP only for localhost, 127.0.0.1 or [::1].
Credentials: PNEU007_TOOL_TOKEN environment variable (never printed).
This CLI does not send A2A messages, perform an audit, or generate a rulebook for the bot.
`;

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
  if (!base || !positionals.length) throw new Error(help.trim());
  let method: string, path: string;
  if (positionals[0] === 'call') {
    if (positionals.length !== 3) throw new Error(help.trim());
    for (const option of options.keys()) if (option !== '--data-file') throw new Error(`${option} is not supported by call`);
    method = positionals[1]!.toUpperCase();
    path = positionals[2]!;
  } else ({ method, path } = namedGarageRequest(positionals, options));
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--url must be an origin without credentials, path, query or fragment');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowLocal)) {
    throw new Error('HTTPS is required; local HTTP needs --allow-http-localhost');
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new Error('PATH must be an absolute path on the explicitly configured origin');
  }
  const target = new URL(path, url);
  if (target.origin !== url.origin) throw new Error('Cannot send credentials to another origin');
  const token = env.PNEU007_TOOL_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw new Error('PNEU007_TOOL_TOKEN is required');
  if (method === 'GET' && dataFile) throw new Error('GET cannot have request data');
  const body = dataFile === undefined ? undefined : readFileSync(dataFile, 'utf8');
  if (body !== undefined) {
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('Request data exceeds 1 MB');
    const payload: unknown = JSON.parse(body);
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
