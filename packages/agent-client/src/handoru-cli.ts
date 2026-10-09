// Portable HTTP fallback for Handle onboarding and business tools. This is not proof of MCP/runtime support.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `handle — authenticated HTTP fallback for onboarding and business tools

Usage:
  handle bootstrap --url https://handle.example
  handle request GET /api/handle/v1/me --url URL --token-file FILE
  handle request POST /api/handle/v1/agent-registrations --url URL --body-file REQUEST.json --save-token FILE
  handle request POST /api/handle/v1/onboarding/ID/credentials --url URL --token-file PROVISIONAL.json --save-token SERVICE.json
  handle request METHOD /path --url URL [--token-file FILE] [--body-file FILE] [--idempotency-key KEY]

URL: --url or HANDLE_URL. Credential: --token-file, HANDLE_TOKEN_FILE, or HANDLE_TOKEN.
Existing HANDORU_* environment variables remain supported.
Token files may contain a token or JSON {"url":"...","token":"..."}. Issued credentials are saved with mode 0600.
Credentials are never printed or placed in URLs. Owner decisions require the independent human browser session.
This CLI uses the same HTTP business path; it does not claim a verified GrokBot or MCP connection.`;

class CliError extends Error {}
const credentialKeys = /^(?:access_token|refresh_token|provisional_credential|token|credential|private_key|password|setup_secret|csrf_token)$/i;

function safeOutput(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => safeOutput(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, credentialKeys.test(key) ? '[redacted]' : safeOutput(item, secrets)]));
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = (value as string).split(secret).join('[redacted]');
  }
  return value;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, 'token-file': { type: 'string' }, 'body-file': { type: 'string' },
    'save-token': { type: 'string' }, 'idempotency-key': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  const [command, methodArg, pathArg] = positionals;
  if (!command || values.help) return void console.log(HELP);
  if (!['bootstrap', 'request'].includes(command)) throw new CliError('Use bootstrap or request. See --help.');
  const base = new URL(values.url ?? process.env.HANDLE_URL ?? process.env.HANDORU_URL ?? '');
  if (base.username || base.password || base.search || base.hash) throw new CliError('Base URL must not contain credentials, query or fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new CliError('Use HTTPS, or local HTTP for a test server.');
  const baseUrl = base.toString().replace(/\/$/, '');
  const method = command === 'bootstrap' ? 'GET' : (methodArg ?? '').toUpperCase();
  const path = command === 'bootstrap' ? '/.well-known/handle.json' : pathArg;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CliError('Supply GET, POST, PUT, PATCH or DELETE.');
  if (!path?.startsWith('/') || path.startsWith('//')) throw new CliError('Request path must begin with one slash.');
  const target = new URL(`${baseUrl}${path}`);
  if (target.origin !== base.origin || target.username || target.password || target.hash) throw new CliError('Requests must stay on the selected Handle origin.');
  for (const name of target.searchParams.keys()) if (/token|credential|secret|password/i.test(name)) throw new CliError('Credentials are not allowed in URL parameters.');
  const tokenFile = values['token-file'] ?? process.env.HANDLE_TOKEN_FILE ?? process.env.HANDORU_TOKEN_FILE;
  let token = (process.env.HANDLE_TOKEN ?? process.env.HANDORU_TOKEN) || undefined;
  if (tokenFile) {
    const raw = readFileSync(tokenFile, 'utf8').trim();
    if (raw.startsWith('{')) {
      const saved = JSON.parse(raw);
      if (saved.url && saved.url.replace(/\/$/, '') !== baseUrl) throw new CliError('Credential file belongs to another Handle URL.');
      token = saved.token ?? saved.access_token ?? saved.provisional_credential;
    } else token = raw;
  }
  if ((tokenFile || token !== undefined) && (typeof token !== 'string' || !token.trim())) throw new CliError('Credential file does not contain a valid token.');
  const issuesCredential = method === 'POST' && (/\/agent-registrations$/.test(target.pathname) || /\/onboarding\/[^/]+\/credentials$/.test(target.pathname) || /\/connections\/[^/]+\/credentials\/rotate$/.test(target.pathname));
  if (issuesCredential && !values['save-token']) throw new CliError('This request issues a credential. Provide --save-token FILE before sending it.');
  let body: string | undefined;
  if (values['body-file']) {
    if (method === 'GET') throw new CliError('GET does not accept --body-file.');
    body = JSON.stringify(JSON.parse(readFileSync(values['body-file'], 'utf8')));
  }
  const response = await fetch(target, { method, body, redirect: 'error', signal: AbortSignal.timeout(60_000), headers: {
    accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(values['idempotency-key'] ? { 'idempotency-key': values['idempotency-key'] } : {}),
  } });
  const payloadText = await response.text();
  if (payloadText.length > 512_000) throw new CliError('Response exceeds the CLI output limit.');
  let payload: any;
  try { payload = JSON.parse(payloadText); } catch { throw new CliError(`HTTP ${response.status}: expected a JSON response.`); }
  const issuedToken = payload.access_token ?? payload.provisional_credential ?? payload.token;
  if (response.ok && typeof issuedToken === 'string' && values['save-token']) {
    const file = values['save-token'];
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ url: baseUrl, token: issuedToken,
      request_id: payload.request_id, business_id: payload.business_id, connection_id: payload.connection_id }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }
  console.log(JSON.stringify(safeOutput(payload, [token ?? '', typeof issuedToken === 'string' ? issuedToken : '']), null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  // Do not echo arbitrary fetch/parser errors, which can contain request credentials or file contents.
  console.error(error instanceof CliError ? `error: ${error.message}` : 'error: request or credential file could not be processed.');
  process.exitCode = 1;
});
