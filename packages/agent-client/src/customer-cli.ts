// Customer credentials stay local; account linking and purchase approval are human actions.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim';
const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const help = `Customer tools (Node >= 18)
  customer link --url HTTPS_ORIGIN --email CUSTOMER_EMAIL
  customer finish                      Poll once after the human confirms account linking
  customer refresh                     Exchange the stored single-use assertion once
  customer identity | catalog | payments | cases
  customer case ID | mandate ID | order ID
  customer create-case --data-file request.json
  customer propose-mandate --data-file request.json
  customer accept CASE_ID --data-file request.json
Credentials: CUSTOMER_CONFIG (default ~/.a2a/customer.json).
A2A export: A2A_CREDENTIALS_FILE (default ~/.a2a/customer-a2a.json).
Human approval is external; this helper cannot approve mandates or initiate checkout.
--allow-http-localhost enables HTTP only for localhost during local tests.
`;

type State = {
  version: 1; origin: string; email: string;
  status: 'registering' | 'pending' | 'finishing' | 'linked' | 'refreshing';
  registration_id?: string; claim_token?: string;
  claim?: { user_code: string; verification_uri: string; expires_at: number; interval: number };
  next_poll_at?: number; access_token?: string; identity_assertion?: string;
  access_expires_at?: number; assertion_expires?: string;
};
type Json = Record<string, unknown>;
class HttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`HTTP ${status}${code ? ` (${code})` : ''}; no credential or response body is displayed.`); }
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n]/.test(value)) throw new Error('Invalid server credential response.');
  return value;
}
function origin(raw: string, allowLocal: boolean): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid business origin.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an origin without credentials, path, query or fragment.');
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('HTTPS is required; local HTTP needs --allow-http-localhost.');
  return url.origin;
}
function readJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Expected a regular JSON file no larger than 1 MB.');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid JSON file.'); }
}
function atomic(path: string, value: unknown): void {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('Credential destination must be a regular file.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
async function request(base: string, path: string, method = 'GET', payload?: Json | URLSearchParams, token?: string): Promise<Json> {
  const url = new URL(path, base);
  if (url.origin !== base) throw new Error('Request origin mismatch.');
  let response: Response;
  try {
    response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': payload instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      body: payload ? payload instanceof URLSearchParams ? payload.toString() : JSON.stringify(payload) : undefined });
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(part.value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let data: Json;
    try { data = object(JSON.parse(raw)); } catch {
      if (!response.ok) throw new HttpError(response.status);
      throw new Error();
    }
    if (!response.ok) {
      const code = typeof data.error === 'string' && ['authorization_pending', 'slow_down', 'expired_token', 'invalid_grant', 'access_denied', 'invalid_token', 'rate_limit_exceeded'].includes(data.error) ? data.error : undefined;
      throw new HttpError(response.status, code);
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new Error('Request failed or response was invalid. A write may have completed; no automatic retry was made.');
  }
}
function print(value: unknown, secrets: string[] = []): void {
  const serialized = JSON.stringify(value, (key, val: unknown) =>
    /(?:token|assertion|password|secret|authorization|cookie|private_key)/i.test(key) && key !== 'user_code' ? '[REDACTED]' : val, 2);
  let output = serialized;
  for (const secret of secrets) if (secret) output = output.split(secret).join('[REDACTED]');
  process.stdout.write(output + '\n');
}
function knownRateLimit(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 429 && error.code === 'rate_limit_exceeded';
}
function rateLimitHandoff(): void {
  print({ status: 'rate_limit_exceeded', retryable: true,
    instruction: 'Wait for the service rate limit to reset, then rerun this command. No request was retried automatically; no registration or credential grant was consumed.' });
}
function handoff(state: State): void {
  if (!state.claim) throw new Error('Missing saved linking instructions.');
  print({ status: 'authorization_pending', registration_id: state.registration_id,
    user_code: state.claim.user_code, verification_uri: state.claim.verification_uri,
    expires_at: new Date(state.claim.expires_at).toISOString(), interval: state.claim.interval,
    instruction: 'The human must open this link, sign in to the matching customer account and enter the code. Then run customer finish.' });
}
function exportA2a(path: string, state: State): void {
  if (!state.access_token) throw new Error('No customer credential to export.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); } catch { throw new Error('A2A credentials are in use; retry export with customer finish after the other process completes.'); }
  try {
    const credentials = existsSync(path) ? object(readJson(path)) : {};
    for (const [key, value] of Object.entries(credentials)) {
      let validOrigin = false;
      try { validOrigin = origin(key, true) === key; } catch { /* Preserve unrelated configuration files. */ }
      if (!validOrigin || typeof value !== 'string') throw new Error('Invalid A2A credential mapping; existing file preserved.');
    }
    atomic(path, { ...credentials, [state.origin]: state.access_token });
  } finally { rmSync(lock, { force: true }); }
}
function tokens(data: Json, state: State): State {
  if (data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid server credential response.');
  return { version: 1, origin: state.origin, email: state.email, status: 'linked', registration_id: state.registration_id,
    access_token: text(data.access_token), identity_assertion: text(data.identity_assertion),
    access_expires_at: Date.now() + data.expires_in * 1000, assertion_expires: text(data.assertion_expires) };
}

export async function customerMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  const options = new Map<string, string>();
  const positional: string[] = [];
  let allowLocal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--allow-http-localhost') { allowLocal = true; continue; }
    if (['--url', '--email', '--data-file'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || options.has(arg)) throw new Error('Missing or duplicate option value.');
      options.set(arg, value);
    } else if (arg.startsWith('-')) throw new Error('Unknown option.');
    else positional.push(arg);
  }
  const command = positional[0];
  const withId = ['case', 'mandate', 'accept', 'order'].includes(command ?? '');
  const withData = ['create-case', 'propose-mandate', 'accept'].includes(command ?? '');
  if (!['link', 'finish', 'refresh', 'identity', 'catalog', 'payments', 'cases', 'case', 'mandate', 'order', 'create-case', 'propose-mandate', 'accept'].includes(command ?? '')
    || positional.length !== (withId ? 2 : 1)) throw new Error('Invalid customer command or arguments. Use --help.');
  for (const option of options.keys()) {
    if (option === '--email' && command !== 'link' || option === '--data-file' && !withData) throw new Error('Option is not supported for this command.');
  }
  if (withData !== options.has('--data-file')) throw new Error('This command requires --data-file.');
  const configPath = resolve(env.CUSTOMER_CONFIG ?? join(homedir(), '.a2a', 'customer.json'));
  const a2aPath = resolve(env.A2A_CREDENTIALS_FILE ?? join(homedir(), '.a2a', 'customer-a2a.json'));
  if (configPath === a2aPath) throw new Error('Customer and A2A credential files must be separate.');
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lock = `${configPath}.lock`;
  try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); } catch { throw new Error('Customer credentials are in use. If a previous process crashed, inspect its state before removing the lock.'); }
  try {
    let state: State | undefined;
    if (existsSync(configPath)) {
      const raw = object(readJson(configPath));
      if (raw.version !== 1 || typeof raw.origin !== 'string' || typeof raw.email !== 'string'
        || !['registering', 'pending', 'finishing', 'linked', 'refreshing'].includes(String(raw.status))) throw new Error('Invalid customer configuration; existing file preserved.');
      state = raw as State;
      origin(state.origin, allowLocal);
      chmodSync(configPath, 0o600);
    }
    const base = options.has('--url') ? origin(options.get('--url')!, allowLocal) : state?.origin;
    if (!base) throw new Error('First link requires --url and --email.');
    if (state && base !== state.origin) throw new Error('Saved customer credentials belong to a different origin; use a separate CUSTOMER_CONFIG.');
    if (command === 'link') {
      const email = options.get('--email')?.trim().toLowerCase();
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A customer email is required.');
      if (state && state.email !== email) throw new Error('Saved customer identity belongs to another email; use a separate CUSTOMER_CONFIG.');
      if (state?.status === 'pending') { handoff(state); return; }
      if (state?.status === 'linked') { exportA2a(a2aPath, state); print({ status: 'linked', registration_id: state.registration_id }); return; }
      if (state) throw new Error('Previous registration or credential delivery is uncertain. Existing state preserved; do not silently register or exchange again.');
      state = { version: 1, origin: base, email, status: 'registering' };
      atomic(configPath, state);
      let data: Json;
      try {
        data = await request(base, '/agent/identity', 'POST', { type: 'service_auth', login_hint: email });
      } catch (error) {
        if (knownRateLimit(error)) { rmSync(configPath); rateLimitHandoff(); return; }
        throw error;
      }
      const claim = object(data.claim);
      const verification = new URL(text(claim.verification_uri));
      if (verification.origin !== base || verification.pathname !== '/agent/claim' || verification.username || verification.password || verification.hash
        || typeof claim.user_code !== 'string' || !/^\d{6}$/.test(claim.user_code)
        || typeof claim.expires_in !== 'number' || claim.expires_in <= 0 || claim.expires_in > 600
        || typeof claim.interval !== 'number' || claim.interval < 5 || claim.interval > 60) throw new Error('Invalid linking response; existing state preserved.');
      state = { ...state, status: 'pending', registration_id: text(data.registration_id), claim_token: text(data.claim_token),
        claim: { user_code: claim.user_code, verification_uri: verification.toString(), expires_at: Date.now() + claim.expires_in * 1000, interval: claim.interval } };
      atomic(configPath, state); handoff(state); return;
    }
    if (!state) throw new Error('Run customer link first.');
    if (command === 'finish' || command === 'refresh') {
      if (command === 'finish' && state.status === 'linked') { exportA2a(a2aPath, state); print({ status: 'linked', registration_id: state.registration_id }); return; }
      if (command === 'finish' && state.status === 'pending') {
        if (!state.claim || !state.claim_token || state.claim.expires_at <= Date.now()) throw new Error('Linking ceremony expired; existing registration preserved.');
        if ((state.next_poll_at ?? 0) > Date.now()) { print({ status: 'slow_down', retry_after_seconds: Math.ceil((state.next_poll_at! - Date.now()) / 1000) }); return; }
        const pending = state;
        atomic(configPath, { ...state, status: 'finishing' });
        try {
          state = tokens(await request(base, '/oauth2/token', 'POST', new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: state.claim_token })), state);
        } catch (error) {
          if (knownRateLimit(error)) { atomic(configPath, pending); rateLimitHandoff(); return; }
          if (error instanceof HttpError && ['authorization_pending', 'slow_down'].includes(error.code ?? '')) {
            atomic(configPath, { ...pending, next_poll_at: Date.now() + pending.claim!.interval * 1000 });
            print({ status: error.code, retry_after_seconds: pending.claim!.interval }); return;
          }
          throw error;
        }
      } else if (command === 'refresh' && state.status === 'linked' && state.identity_assertion) {
        const linked = state;
        atomic(configPath, { ...state, status: 'refreshing' });
        try {
          state = tokens(await request(base, '/oauth2/token', 'POST', new URLSearchParams({ grant_type: JWT_GRANT, assertion: state.identity_assertion })), state);
        } catch (error) {
          if (knownRateLimit(error)) { atomic(configPath, linked); rateLimitHandoff(); return; }
          throw error;
        }
      } else throw new Error('No eligible pending claim or assertion; existing state preserved without retry.');
      atomic(configPath, state); exportA2a(a2aPath, state);
      print({ status: 'linked', registration_id: state.registration_id, access_expires_at: new Date(state.access_expires_at!).toISOString() }); return;
    }
    if (state.status !== 'linked' || !state.access_token) throw new Error('Customer account linking must finish first.');
    if ((state.access_expires_at ?? 0) <= Date.now()) throw new Error('Customer credential expired. Run customer refresh; no automatic exchange was made.');
    if (withId && (['.', '..'].includes(positional[1]!) || positional[1]!.length > 512 || /[\r\n]/.test(positional[1]!))) throw new Error('Invalid resource ID.');
    const id = withId ? encodeURIComponent(positional[1]!) : '';
    const paths: Record<string, string> = { identity: '/api/agent/identity', catalog: '/api/services', payments: '/api/payments/config', cases: '/api/agent/cases',
      case: `/api/agent/cases/${id}`, mandate: `/api/agent/mandates/${id}`, order: `/api/agent/orders/${id}`, 'create-case': '/api/agent/cases',
      'propose-mandate': '/api/agent/mandates', accept: `/api/agent/cases/${id}/accept` };
    const payload = withData ? object(readJson(options.get('--data-file')!)) : undefined;
    const data = await request(base, paths[command!]!, withData ? 'POST' : 'GET', payload, state.access_token);
    if (command === 'propose-mandate') {
      const mandate = object(data.mandate);
      data.approval_url = `${base}/agent/mandates?mandate_id=${encodeURIComponent(text(mandate.id))}`;
      data.instruction = 'The human customer must review and approve this mandate in the website. This response does not grant approval.';
    }
    print(data, [state.access_token, state.identity_assertion ?? '', state.claim_token ?? '']);
  } finally { rmSync(lock, { force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  customerMain(process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof Error ? error.message : 'Customer operation failed.') + '\n');
    process.exitCode = 1;
  });
}
