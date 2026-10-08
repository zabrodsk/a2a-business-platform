import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/customer-cli.ts', import.meta.url));

type Call = { path: string; method: string; auth?: string; body: string };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'customer-cli-'));
  const calls: Call[] = [];
  let handler: (call: Call, req: IncomingMessage, res: ServerResponse) => void = () => {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = { path: req.url!, method: req.method!, auth: req.headers.authorization, body };
    calls.push(call);
    res.setHeader('content-type', 'application/json');
    handler(call, req, res);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const env = { CUSTOMER_CONFIG: join(directory, 'customer.json'), A2A_CREDENTIALS_FILE: join(directory, 'a2a.json') };
  const registration = { registration_id: 'reg_test', claim_token: 'clm_private_never_print',
    claim: { user_code: '123456', verification_uri: `${base}/agent/claim?claim_attempt_token=human_handoff`, expires_in: 600, interval: 5 } };
  const credential = { access_token: 'agt_private_never_print', identity_assertion: 'assertion_private_never_print', token_type: 'Bearer', expires_in: 3600, assertion_expires: '2026-10-10T00:00:00Z' };
  async function run(args: string[]) {
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', entry, ...args, '--allow-http-localhost'], { env: { ...process.env, ...env } });
    return JSON.parse(stdout);
  }
  function saveLinked() {
    writeFileSync(env.CUSTOMER_CONFIG, JSON.stringify({ version: 1, status: 'linked', origin: base, email: 'alice@example.com',
      registration_id: 'reg_test', ...credential, access_expires_at: Date.now() + 3600_000 }));
  }
  return { base, calls, directory, env, registration, credential, run, saveLinked,
    on(next: typeof handler) { handler = next; },
    async cleanup() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); } };
}

test('link reuses pending registration and finish stores private credentials and exports A2A without leaking them', async () => {
  const f = await fixture();
  try {
    let claimed = false;
    f.on((call, _req, res) => {
      if (call.path === '/agent/identity') { assert.deepEqual(JSON.parse(call.body), { type: 'service_auth', login_hint: 'alice@example.com' }); assert.equal(call.auth, undefined); res.end(JSON.stringify(f.registration)); }
      else {
        assert.equal(call.path, '/oauth2/token');
        assert.equal(new URLSearchParams(call.body).get('grant_type'), 'urn:workos:agent-auth:grant-type:claim');
        assert.equal(new URLSearchParams(call.body).get('claim_token'), f.registration.claim_token);
        if (claimed) res.end(JSON.stringify(f.credential));
        else { res.statusCode = 400; res.end(JSON.stringify({ error: 'authorization_pending', error_description: f.registration.claim_token })); }
      }
    });
    const linkArgs = ['link', '--url', f.base, '--email', 'Alice@example.com'];
    const first = await f.run(linkArgs);
    assert.equal(first.user_code, '123456');
    assert.equal(first.verification_uri, f.registration.claim.verification_uri);
    assert(!JSON.stringify(first).includes(f.registration.claim_token));
    assert.deepEqual(await f.run(linkArgs), first);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.run(['finish'])).status, 'authorization_pending');
    assert.equal((await f.run(['finish'])).status, 'slow_down');
    assert.equal(f.calls.length, 2);
    const pending = JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')); pending.next_poll_at = 0;
    writeFileSync(f.env.CUSTOMER_CONFIG, JSON.stringify(pending));
    claimed = true;
    writeFileSync(f.env.A2A_CREDENTIALS_FILE, JSON.stringify({ 'https://other.example': 'other-token' }));
    const finished = await f.run(['finish']);
    assert.equal(finished.status, 'linked');
    for (const secret of Object.values(f.credential).filter(value => typeof value === 'string')) assert(!JSON.stringify(finished).includes(secret));
    const saved = JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8'));
    assert.equal(saved.access_token, f.credential.access_token);
    assert.equal(saved.identity_assertion, f.credential.identity_assertion);
    assert.equal(saved.claim_token, undefined);
    assert.deepEqual(JSON.parse(readFileSync(f.env.A2A_CREDENTIALS_FILE, 'utf8')), { 'https://other.example': 'other-token', [f.base]: f.credential.access_token });
    assert.equal(statSync(f.env.CUSTOMER_CONFIG).mode & 0o777, 0o600);
    assert.equal(statSync(f.env.A2A_CREDENTIALS_FILE).mode & 0o777, 0o600);
    await f.run(['finish']); assert.equal(f.calls.length, 3);
  } finally { await f.cleanup(); }
});

test('refresh exchanges one assertion and preserves updated credentials without printing secrets', async () => {
  const f = await fixture();
  try {
    f.saveLinked();
    f.on((call, _req, res) => {
      assert.equal(call.path, '/oauth2/token'); assert.equal(call.method, 'POST'); assert.equal(call.auth, undefined);
      assert.equal(new URLSearchParams(call.body).get('assertion'), f.credential.identity_assertion);
      assert.equal(new URLSearchParams(call.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      res.end(JSON.stringify({ ...f.credential, access_token: 'replacement-access', identity_assertion: 'replacement-assertion' }));
    });
    assert.equal((await f.run(['refresh'])).status, 'linked');
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).identity_assertion, 'replacement-assertion');
    assert.equal(JSON.parse(readFileSync(f.env.A2A_CREDENTIALS_FILE, 'utf8'))[f.base], 'replacement-access');
  } finally { await f.cleanup(); }
});

test('uncertain single-use refresh is never retried automatically', async () => {
  const f = await fixture();
  try {
    f.saveLinked();
    f.on((_call, req) => req.socket.destroy());
    await assert.rejects(f.run(['refresh']), /no automatic retry/);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'refreshing');
    await assert.rejects(f.run(['refresh']), /without retry/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('uncertain registration remains saved and repeat link cannot create another identity', async () => {
  const f = await fixture();
  try {
    f.on((_call, req) => req.socket.destroy());
    const args = ['link', '--url', f.base, '--email', 'alice@example.com'];
    await assert.rejects(f.run(args), /no automatic retry/);
    await assert.rejects(f.run(args), /uncertain/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('origin overrides and HTTP redirects never receive saved credentials', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    f.saveLinked();
    await assert.rejects(f.run(['identity', '--url', other.base]), /different origin/);
    f.on((_call, _req, res) => { res.statusCode = 302; res.setHeader('location', `${other.base}/steal`); res.end('{}'); });
    await assert.rejects(f.run(['identity']), /Request failed/);
    assert.equal(other.calls.length, 0);
    assert.equal(f.calls[0]!.auth, `Bearer ${f.credential.access_token}`);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test('API commands preserve methods, escape IDs, and hand mandate approval to a human', async () => {
  const f = await fixture();
  try {
    f.saveLinked();
    const data = join(f.directory, 'request.json'); writeFileSync(data, JSON.stringify({ customer_context: { requested: 'tyres' } }));
    f.on((call, _req, res) => {
      assert.equal(call.auth, `Bearer ${f.credential.access_token}`);
      res.end(JSON.stringify(call.path === '/api/agent/mandates' ? { mandate: { id: 'm?&/1', status: 'proposed' } } : { ok: true, message: f.credential.access_token, identity_assertion: 'unrelated-secret' }));
    });
    const requests: Array<[string[], string, string]> = [
      [['identity'], 'GET', '/api/agent/identity'], [['catalog'], 'GET', '/api/services'], [['payments'], 'GET', '/api/payments/config'],
      [['cases'], 'GET', '/api/agent/cases'], [['case', 'x?query#hash/'], 'GET', '/api/agent/cases/x%3Fquery%23hash%2F'],
      [['mandate', 'm1'], 'GET', '/api/agent/mandates/m1'], [['order', 'o1'], 'GET', '/api/agent/orders/o1'],
      [['create-case', '--data-file', data], 'POST', '/api/agent/cases'], [['accept', 'c1', '--data-file', data], 'POST', '/api/agent/cases/c1/accept'],
    ];
    for (const [args, method, path] of requests) {
      const result = await f.run(args);
      assert(!JSON.stringify(result).includes(f.credential.access_token));
      assert.equal(result.identity_assertion, '[REDACTED]');
      assert.equal(f.calls.at(-1)!.method, method); assert.equal(f.calls.at(-1)!.path, path);
    }
    const mandate = await f.run(['propose-mandate', '--data-file', data]);
    assert.equal(mandate.approval_url, `${f.base}/agent/mandates?mandate_id=m%3F%26%2F1`);
    assert.equal(mandate.mandate.status, 'proposed');
    assert(f.calls.every(call => !/confirm|approve|checkout/.test(call.path)));
    await assert.rejects(f.run(['case', '..']), /Invalid resource ID/);
  } finally { await f.cleanup(); }
});

test('HTTP errors omit response bodies and OAuth credential values', async () => {
  const f = await fixture();
  try {
    f.saveLinked();
    f.on((_call, _req, res) => { res.statusCode = 403; res.end(JSON.stringify({ error: 'access_denied', error_description: f.credential.access_token })); });
    await assert.rejects(f.run(['cases']), error => { assert(error instanceof Error); assert.match(error.message, /HTTP 403 \(access_denied\)/); assert(!error.message.includes(f.credential.access_token)); return true; });
  } finally { await f.cleanup(); }
});

test('rejects unsafe business origins, malformed request data, and unrelated config destinations', async () => {
  const f = await fixture();
  try {
    for (const bad of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#x', 'http://example.com']) {
      await assert.rejects(f.run(['link', '--url', bad, '--email', 'alice@example.com']));
    }
    f.saveLinked();
    const data = join(f.directory, 'bad.json'); writeFileSync(data, '[]');
    await assert.rejects(f.run(['create-case', '--data-file', data]), /JSON object/);
    writeFileSync(f.env.A2A_CREDENTIALS_FILE, JSON.stringify({ role: 'business_agent', url: 'https://example.com', token: 'private-business-token' }));
    await assert.rejects(f.run(['finish']), /existing file preserved/);
    assert.equal(JSON.parse(readFileSync(f.env.A2A_CREDENTIALS_FILE, 'utf8')).token, 'private-business-token');
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('an uncertain claim delivery cannot be polled again and local HTTP requires its explicit flag', async () => {
  const f = await fixture();
  try {
    await assert.rejects(execute(process.execPath, ['--import', 'tsx', entry, 'link', '--url', f.base, '--email', 'alice@example.com'], { env: { ...process.env, ...f.env } }), /local HTTP needs/);
    assert.equal(f.calls.length, 0);
    f.on((_call, _req, res) => res.end(JSON.stringify(f.registration)));
    await f.run(['link', '--url', f.base, '--email', 'alice@example.com']);
    f.on((_call, req) => req.socket.destroy());
    await assert.rejects(f.run(['finish']), /no automatic retry/);
    await assert.rejects(f.run(['finish']), /without retry/);
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'finishing');
  } finally { await f.cleanup(); }
});

test('server slow_down stays pending and an invalid claim origin is never handed to the human', async () => {
  const f = await fixture();
  try {
    f.on((_call, _req, res) => res.end(JSON.stringify(f.registration)));
    await f.run(['link', '--url', f.base, '--email', 'alice@example.com']);
    f.on((_call, _req, res) => { res.statusCode = 400; res.end(JSON.stringify({ error: 'slow_down' })); });
    assert.equal((await f.run(['finish'])).status, 'slow_down');
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'pending');
    rmSync(f.env.CUSTOMER_CONFIG);
    f.on((_call, _req, res) => res.end(JSON.stringify({ ...f.registration, claim: { ...f.registration.claim, verification_uri: 'https://attacker.example/agent/claim' } })));
    await assert.rejects(f.run(['link', '--url', f.base, '--email', 'alice@example.com']), /Invalid linking response/);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'registering');
  } finally { await f.cleanup(); }
});

test('known OAuth registration rate limits allow explicit retry without leaving a phantom registration', async () => {
  const f = await fixture();
  try {
    f.on((_call, _req, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate_limit_exceeded', error_description: f.registration.claim_token })); });
    const args = ['link', '--url', f.base, '--email', 'alice@example.com'];
    const limited = await f.run(args);
    assert.equal(limited.status, 'rate_limit_exceeded'); assert.equal(limited.retryable, true);
    assert(!JSON.stringify(limited).includes(f.registration.claim_token));
    assert.throws(() => statSync(f.env.CUSTOMER_CONFIG), /ENOENT/);
    assert.equal(f.calls.length, 1);
    f.on((_call, _req, res) => res.end(JSON.stringify(f.registration)));
    assert.equal((await f.run(args)).status, 'authorization_pending');
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('known OAuth token rate limits preserve pending claim and linked assertion for explicit retries', async () => {
  const f = await fixture();
  try {
    f.on((_call, _req, res) => res.end(JSON.stringify(f.registration)));
    await f.run(['link', '--url', f.base, '--email', 'alice@example.com']);
    const pending = JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8'));
    f.on((_call, _req, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate_limit_exceeded', error_description: f.registration.claim_token })); });
    const limitedClaim = await f.run(['finish']);
    assert.equal(limitedClaim.status, 'rate_limit_exceeded');
    assert(!JSON.stringify(limitedClaim).includes(f.registration.claim_token));
    assert.deepEqual(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')), pending);
    assert.equal(f.calls.length, 2);
    f.on((call, _req, res) => { assert.equal(new URLSearchParams(call.body).get('claim_token'), f.registration.claim_token); res.end(JSON.stringify(f.credential)); });
    await f.run(['finish']);
    const linked = JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8'));
    f.on((_call, _req, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate_limit_exceeded', error_description: f.credential.identity_assertion })); });
    const limitedRefresh = await f.run(['refresh']);
    assert.equal(limitedRefresh.status, 'rate_limit_exceeded');
    assert(!JSON.stringify(limitedRefresh).includes(f.credential.identity_assertion));
    assert(!JSON.stringify(limitedRefresh).includes(f.credential.access_token));
    assert.deepEqual(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')), linked);
    assert.equal(f.calls.length, 4);
    f.on((call, _req, res) => { assert.equal(new URLSearchParams(call.body).get('assertion'), f.credential.identity_assertion); res.end(JSON.stringify({ ...f.credential, identity_assertion: 'rotated-after-rate-limit' })); });
    await f.run(['refresh']);
    assert.equal(f.calls.length, 5);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).identity_assertion, 'rotated-after-rate-limit');
  } finally { await f.cleanup(); }
});

test('unknown proxy 429 keeps all in-flight guards because consumption is uncertain', async () => {
  const f = await fixture();
  try {
    const args = ['link', '--url', f.base, '--email', 'alice@example.com'];
    f.on((_call, _req, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: 'proxy_limit', error_description: 'opaque proxy response' })); });
    await assert.rejects(f.run(args), /HTTP 429/);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'registering');
    await assert.rejects(f.run(args), /uncertain/); assert.equal(f.calls.length, 1);
    rmSync(f.env.CUSTOMER_CONFIG);
    f.on((_call, _req, res) => res.end(JSON.stringify(f.registration)));
    await f.run(args);
    f.on((_call, _req, res) => { res.statusCode = 429; res.end('{}'); });
    await assert.rejects(f.run(['finish']), /HTTP 429/);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'finishing');
    await assert.rejects(f.run(['finish']), /without retry/); assert.equal(f.calls.length, 3);
    f.saveLinked();
    await assert.rejects(f.run(['refresh']), /HTTP 429/);
    assert.equal(JSON.parse(readFileSync(f.env.CUSTOMER_CONFIG, 'utf8')).status, 'refreshing');
    await assert.rejects(f.run(['refresh']), /without retry/); assert.equal(f.calls.length, 4);
  } finally { await f.cleanup(); }
});
