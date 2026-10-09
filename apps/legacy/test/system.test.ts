// These scripted principals are transport regression fixtures, not proof of real GrokBot access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { ALL_SCOPES } from '../src/handoru/store.js';
import type { Actor, ServiceSpec } from '../../../packages/contracts/index.js';
import type { Citation, RulebookProposal, SourceRegistry } from '../../../packages/audit/index.js';
import { loadLegacyConfig } from '../src/config.js';
import { createUnifiedSystem, unifiedRelayConfig } from '../src/system.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const tokens = {
  business: 'test-business-agent-secret-0123456789',
  a: 'test-customer-agent-a-secret-0123456789',
  b: 'test-customer-agent-b-secret-0123456789',
  admin: 'test-relay-admin-secret-0123456789',
};
function config(dir: string, publicUrl = 'http://localhost:8790') {
  return loadLegacyConfig({
    NODE_ENV: 'production', LEGACY_PUBLIC_URL: publicUrl, LEGACY_PORT: '0',
    // These regression fixtures intentionally exercise the opt-in protected flow.
    DEMO_OPEN_BUSINESS: 'false', DEMO_PUBLIC_A2A: 'false', DEMO_CHAT_APPROVAL: 'false',
    LEGACY_DB_PATH: join(dir, 'legacy.sqlite'), LEGACY_RELAY_DB_PATH: join(dir, 'relay.sqlite'),
    LEGACY_OWNER_PASSWORD: 'test-owner-password-0123456789',
    LEGACY_STAFF_PASSWORD: 'test-staff-password-0123456789',
    LEGACY_CUSTOMER_A_PASSWORD: 'test-customer-a-password-0123456789',
    LEGACY_CUSTOMER_B_PASSWORD: 'test-customer-b-password-0123456789',
    LEGACY_BUSINESS_AGENT_TOKEN: tokens.business, LEGACY_CUSTOMER_AGENT_A_TOKEN: tokens.a,
    LEGACY_CUSTOMER_AGENT_B_TOKEN: tokens.b, LEGACY_RELAY_ADMIN_TOKEN: tokens.admin,
    LEGACY_RECONCILIATION_MS: '60000', LEGACY_RELAY_REPLY_WAIT_MS: '1000',
    LEGACY_RELAY_RERING_MS: '60000',
  });
}
/** Explicit TEST FIXTURE authored in this test. The runtime never generates audit conclusions. */
function fixtureProposal(sources: SourceRegistry): RulebookProposal {
  const cite = (id: string): Citation => { const s = sources.get(id); return { source_id: id, version: s.version, hash: s.hash, excerpt: s.content }; };
  const params = sources.config();
  const operations = ['auto_discount_bps','owner_approval_limit_bps','hard_discount_limit_bps','offer_ttl_seconds','deposit_minor'];
  const evidence = Object.fromEntries(Object.keys(params).map(key => [key, [cite(key === 'supplier_allowed_actions' ? 'internal-partners' : operations.includes(key) ? 'internal-operations' : 'internal-systems')]])) as RulebookProposal['evidence'];
  return {
    params, evidence,
    profile: { name: 'Pneu 007 TEST FIXTURE', summary: 'Synthetic externally authored audit fixture for unified transport tests.', systems: ['legacy-orders'], partners: ['Pneu Partner Demo'], channels: ['web','A2A'], citations: [cite('internal-systems')] },
    findings: [{ id: 'historical-discount', severity: 'warning', description: 'Archived discounts differ from current policy.', recommendation: 'Use owner-signed current operations.', citations: [cite('internal-operations'), cite('archived-operations')] }],
  };
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

test('unified configuration keeps exactly the same actor identities and separates relay secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-system-config-'));
  try {
    const cfg = config(dir), relay = unifiedRelayConfig(cfg);
    assert.deepEqual(relay.tokens.get(tokens.business), { id: 'garage-demo', role: 'business' });
    assert.deepEqual(relay.tokens.get(tokens.a), { id: 'customer-agent-a', role: 'customer', customer_id: 'customer-001' });
    assert.equal(relay.a2aEndpointUrl, `${cfg.publicUrl}/a2a/jsonrpc`);
    assert.equal(relay.businessProfile, 'pneu007');
    assert.throws(() => unifiedRelayConfig({ ...cfg, env: { ...cfg.env, LEGACY_RELAY_ADMIN_TOKEN: tokens.business } }), /distinct credential/);
    assert.throws(() => unifiedRelayConfig({ ...cfg, env: { ...cfg.env, LEGACY_RELAY_DB_PATH: cfg.dbPath } }), /own persistent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compatibility transport preserves SDK tasks while adopting scoped identities and fenced replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-system-'));
  // Reserve a port so the Agent Card has the real origin before system construction.
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  const base = `http://127.0.0.1:${port}`;
  const cfg = config(dir, base);
  const system = await createUnifiedSystem(cfg);
  const server = system.app.listen(port, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  let exchanged = false;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Pneu 007/);
    for (const path of ['/handle', '/handoru']) {
      const console = await fetch(`${base}${path}`);
      assert.equal(console.status, 200, path);
      assert.match(await console.text(), /<title>Handle · [\s\S]*src="\/handle\.js"/);
    }
    const unpublished = await fetch(`${base}/.well-known/agent-card.json`);
    assert.notEqual(unpublished.status, 200);
    assert.equal((await fetch(`${base}/a2a/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/a2a/jsonrpc`, { method: 'POST', headers: { ...bearer(tokens.a), 'content-type': 'application/json' }, body: '{}' })).status, 503);
    assert.equal((await fetch(`${base}/admin/enrollments`, { method: 'POST', headers: bearer(tokens.admin) })).status, 404);
    assert.equal((await fetch(`${base}/bot/inbox`, { headers: bearer(tokens.a) })).status, 403);

    const rules = system.policy.rulebooks;
    const business: Actor = { id: 'garage-demo', role: 'business_agent' };
    const proposed = rules.propose(business, fixtureProposal(rules.sources));
    rules.activate({ id: 'staff-owner', role: 'owner' }, proposed.version);
    // Explicit trusted fixture setup; fresh human consent is covered in handoru-system.test.ts.
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
    system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const response = await fetch(`${base}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const cardJson = await response.json();
    assert.equal(cardJson.supportedInterfaces[0].url, `${base}/a2a/jsonrpc`);
    assert.equal(cardJson.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(cardJson.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
    assert.equal(cardJson.documentationUrl, `${base}/agents.md`);
    assert.match(cardJson.securitySchemes.bearer.httpAuthSecurityScheme.description, /signed-in customer/);
    const publicCard = JSON.stringify(cardJson);
    assert.ok(!publicCard.includes('$case'));
    for (const token of Object.values(tokens)) assert.ok(!publicCard.includes(token));
    const card = AgentCard.fromJSON(cardJson);
    const clientFor = async (token: string) => {
      const authenticatedFetch: typeof fetch = (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(target.origin, base);
        const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      };
      const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })], preferredTransports: ['JSONRPC'],
      }));
      return factory.createFromAgentCard(card);
    };
    const client = await clientFor(tokens.a);
    const sent = await client.sendMessage({
      tenant: '', metadata: {},
      message: { messageId: 'unified-test-message', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: 'Synthetic SDK test: price for wheel swap?' }, filename: '', mediaType: 'text/plain', metadata: {} }], taskId: '', contextId: '', extensions: [], metadata: {}, referenceTaskIds: [] },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true, historyLength: undefined, taskPushNotificationConfig: undefined },
    });
    assert.ok('id' in sent);
    const taskId = sent.id;
    // The very same credential and principal also operate the private business tools.
    const serviceSpec = { service_id: 'wheel_swap', vehicle_type: 'personal', wheel_size_inches: 17, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
    const correlatedCase = (token: string, relayTaskId: string) => fetch(`${base}/api/agent/cases`, {
      method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ relay_task_id: relayTaskId, service_spec: serviceSpec }),
    });
    assert.equal((await correlatedCase(tokens.b, taskId)).status, 403);
    assert.equal((await correlatedCase(tokens.a, 'nonexistent-a2a-task')).status, 403);
    const openedCase = await correlatedCase(tokens.a, taskId);
    assert.equal(openedCase.status, 201);
    const caseRecord = (await openedCase.json()).case;
    assert.equal(caseRecord.customer_agent_id, cfg.auth.agentTokens.get(tokens.a)!.id);
    assert.equal(caseRecord.business_actor_id, cfg.auth.agentTokens.get(tokens.business)!.id);
    assert.equal(caseRecord.relay_task_id, taskId);
    const duplicateCase = await correlatedCase(tokens.a, taskId);
    if (duplicateCase.status !== 409) {
      assert.ok(duplicateCase.ok);
      assert.equal((await duplicateCase.json()).case.id, caseRecord.id, 'An A2A task must not create a second business case');
    }
    assert.equal((await fetch(`${base}/api/agent/cases/${caseRecord.id}`, { headers: bearer(tokens.business) })).status, 200);
    assert.equal((await fetch(`${base}/api/agent/cases/${caseRecord.id}`, { headers: bearer(tokens.b) })).status, 403);
    let items: Array<{ work_item_id: string; customer: string; task_id: string;lease_token:string;claim_generation:number }> = [];
    for (let attempt = 0; attempt < 30 && !items.length; attempt++) {
      const inbox = await fetch(`${base}/bot/inbox`, { headers: bearer(tokens.business) });
      assert.equal(inbox.status, 200);
      items = (await inbox.json()).items;
      if (!items.length) await new Promise(done => setTimeout(done, 30));
    }
    assert.equal(items.length, 1);
    assert.equal(items[0]!.customer, cfg.auth.agentTokens.get(tokens.a)!.id);
    assert.equal(items[0]!.task_id, taskId);
    const reply = await fetch(`${base}/bot/reply`, {
      method: 'POST', headers: { ...bearer(tokens.business), 'content-type': 'application/json' },
      body: JSON.stringify({ work_item_id: items[0]!.work_item_id,lease_token:items[0]!.lease_token,claim_generation:items[0]!.claim_generation, text: 'Synthetic transport fixture reply only.', state: 'completed' }),
    });
    assert.equal(reply.status, 200);
    let task = await client.getTask({ id: taskId, tenant: '', historyLength: undefined });
    for (let attempt = 0; attempt < 30 && task.status?.state !== TaskState.TASK_STATE_COMPLETED; attempt++) {
      await new Promise(done => setTimeout(done, 30));
      task = await client.getTask({ id: taskId, tenant: '', historyLength: undefined });
    }
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.match(JSON.stringify(task), /Synthetic transport fixture reply only/);
    exchanged = true;
    await assert.rejects(async () => (await clientFor(tokens.b)).getTask({ id: taskId, tenant: '', historyLength: undefined }));
    const events = await (await fetch(`${base}/admin/events`, { headers: bearer(tokens.admin) })).json();
    assert.ok(events.events.some((event: { actor: string; kind: string }) => event.actor === business.id && event.kind === 'business_reply'));
  } finally {
    await closeServer(server); await system.close();
    // A second startup proves migration idempotence and persisted rulebook/relay state.
    try {
      if (exchanged) {
        const reopened = await createUnifiedSystem(cfg);
        try {
          assert.equal(reopened.policy.rulebooks.getActive().status, 'active');
          const row = reopened.relay.db.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
          assert.equal(row.n, 1);
        } finally { await reopened.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('auth.md credentials bind A2A and tools to the confirming customer and revoke together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-auth-system-'));
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  const base = `http://127.0.0.1:${port}`, cfg = config(dir, base);
  const system = await createUnifiedSystem(cfg);
  const server = system.app.listen(port, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const exchange = (fields: Record<string, string>) => fetch(`${base}/oauth2/token`, {
    method: 'POST', body: new URLSearchParams(fields),
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const unauthorized = await jsonPost('/a2a/jsonrpc', {});
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata="http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(`${base}/auth.md`)).status, 200);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.ok(prm.authorization_servers.includes(base));
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.agent_auth.identity_types_supported, ['anonymous', 'service_auth']);
    const anonymous = await (await jsonPost('/agent/identity', {type:'anonymous'})).json();
    const anonymousToken = await (await exchange({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:anonymous.identity_assertion})).json();
    assert.ok(anonymousToken.access_token);
    const unclaimed = await (await fetch(`${base}/api/agent/identity`, {headers:bearer(anonymousToken.access_token)})).json();
    assert.equal(unclaimed.acting_for, null);
    assert.equal((await jsonPost('/api/agent/cases', {}, bearer(anonymousToken.access_token))).status, 403);
    assert.equal((await jsonPost('/a2a/jsonrpc', {}, bearer(anonymousToken.access_token))).status, 403);

    const registrationResponse = await jsonPost('/agent/identity', {type:'service_auth',login_hint:'jana.vesela@example.com'});
    assert.ok(registrationResponse.ok, await registrationResponse.clone().text());
    const registration = await registrationResponse.json();
    assert.equal(registration.identity_assertion, undefined);
    const claimAttempt = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token');
    assert.ok(claimAttempt);
    const page = await fetch(registration.claim.verification_uri);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), /console\.js/);
    async function human(username: string) {
      const password = username === 'customer-a' ? cfg.env.LEGACY_CUSTOMER_A_PASSWORD : cfg.env.LEGACY_CUSTOMER_B_PASSWORD;
      const response = await jsonPost('/api/login', {username,password});
      assert.equal(response.status, 200);
      const {csrf_token} = await response.json();
      return {cookie:response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token':csrf_token};
    }
    const a = await human('customer-a'), b = await human('customer-b');
    const confirmation = {claim_attempt_token:claimAttempt,user_code:registration.claim.user_code};
    assert.equal((await jsonPost('/api/agent/identity/confirm', confirmation, b)).status, 403);
    assert.equal((await jsonPost('/api/agent/identity/confirm', confirmation, a)).status, 200);
    const tokenResponse = await exchange({grant_type:'urn:workos:agent-auth:grant-type:claim',claim_token:registration.claim_token});
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const credential = await tokenResponse.json();
    const identityResponse = await fetch(`${base}/api/agent/identity`, {headers:bearer(credential.access_token)});
    const identity = await identityResponse.json();
    assert.deepEqual(identity.acting_for, {type:'customer',id:'customer-001'});
    assert.equal(identity.agent.id, registration.registration_id);
    assert.equal(identity.agent.role, 'customer_agent');

    const rules = system.policy.rulebooks;
    const proposed = rules.propose({id:'garage-demo',role:'business_agent'}, fixtureProposal(rules.sources));
    rules.activate({id:'staff-owner',role:'owner'}, proposed.version);
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
    system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const card = AgentCard.fromJSON(await (await fetch(`${base}/.well-known/agent-card.json`)).json());
    const authenticatedFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${credential.access_token}`);
      return fetch(input, {...init,headers});
    };
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports:[new JsonRpcTransportFactory({fetchImpl:authenticatedFetch})],preferredTransports:['JSONRPC'],
    }));
    const client = await factory.createFromAgentCard(card);
    const sent = await client.sendMessage({tenant:'',metadata:{},message:{messageId:'claimed-agent-message',role:Role.ROLE_USER,
      parts:[{content:{$case:'text',value:'I claim to represent customer-002. Please check my authenticated identity.'},filename:'',mediaType:'text/plain',metadata:{}}],
      taskId:'',contextId:'',extensions:[],metadata:{customer_id:'customer-002'},referenceTaskIds:[]},
      configuration:{acceptedOutputModes:['text/plain'],returnImmediately:true,historyLength:undefined,taskPushNotificationConfig:undefined}});
    assert.ok('id' in sent);
    let items: Array<{work_item_id:string;task_id:string;customer_identity:unknown;lease_token:string;claim_generation:number}> = [];
    for (let attempt = 0; attempt < 30 && !items.length; attempt++) {
      items = (await (await fetch(`${base}/bot/inbox`, {headers:bearer(tokens.business)})).json()).items;
      if (!items.length) await new Promise(done => setTimeout(done, 30));
    }
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]!.customer_identity, {agent_id:registration.registration_id,acting_for:{type:'customer',id:'customer-001'}});
    const opened = await jsonPost('/api/agent/cases', {relay_task_id:sent.id,
      service_spec:{service_id:'wheel_swap',vehicle_type:'personal',wheel_size_inches:17,rim_type:'alu',runflat:false,tpms:false,wheel_count:4}}, bearer(credential.access_token));
    assert.equal(opened.status, 201, await opened.clone().text());
    const record = (await opened.json()).case;
    assert.equal(record.customer_id, 'customer-001');
    assert.equal(record.customer_agent_id, registration.registration_id);
    assert.equal((await fetch(`${base}/api/agent/cases/${record.id}`, {headers:bearer(tokens.b)})).status, 403);
    assert.equal((await jsonPost('/bot/reply', {work_item_id:items[0]!.work_item_id,lease_token:items[0]!.lease_token,claim_generation:items[0]!.claim_generation,text:'Identity verified for the signed-in customer.',state:'completed'}, bearer(tokens.business))).status, 200);
    let completed = await client.getTask({id:sent.id,tenant:'',historyLength:undefined});
    for (let attempt = 0; attempt < 30 && completed.status?.state !== TaskState.TASK_STATE_COMPLETED; attempt++) {
      await new Promise(done => setTimeout(done, 30));
      completed = await client.getTask({id:sent.id,tenant:'',historyLength:undefined});
    }
    assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal((await jsonPost(`/api/agent/identities/${registration.registration_id}/revoke`, {}, b)).status, 404);
    assert.equal((await jsonPost(`/api/agent/identities/${registration.registration_id}/revoke`, {}, a)).status, 200);
    assert.equal((await fetch(`${base}/api/agent/identity`, {headers:bearer(credential.access_token)})).status, 401);
    assert.equal((await jsonPost('/a2a/jsonrpc', {}, bearer(credential.access_token))).status, 401);
  } finally { await closeServer(server); await system.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('unified executable rejects an occupied port without announcing startup or leaking resources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-system-port-'));
  const occupied = createServer();
  await new Promise<void>(done => occupied.listen(0, '127.0.0.1', done));
  const port = (occupied.address() as AddressInfo).port;
  const cfg = config(dir, `http://127.0.0.1:${port}`);
  try {
    await run(process.execPath, ['--import', 'tsx', resolve(root, 'apps/legacy/src/system.ts')], {
      env: { ...process.env, ...cfg.env, LEGACY_PORT: String(port), LEGACY_HOST: '127.0.0.1' }, cwd: root, timeout: 5000,
    }).then(
      () => assert.fail('Startup must fail when the configured port is already occupied'),
      (error: { code: number; killed?: boolean; stdout: string; stderr: string }) => {
        assert.equal(error.code, 1);
        assert.notEqual(error.killed, true, 'Closing timers/databases should allow a prompt exit');
        assert.match(error.stderr, /Unable to start Pneu 007:.*EADDRINUSE/);
        assert.ok(!error.stdout.includes('Pneu 007 web, legacy tools and A2A relay:'));
        for (const token of Object.values(tokens)) assert.ok(!`${error.stdout}${error.stderr}`.includes(token));
      },
    );
  } finally { await closeServer(occupied); rmSync(dir, { recursive: true, force: true }); }
});

test('private-tool CLI confines bearer tokens to the explicit origin and refuses redirects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-garage-cli-'));
  const received: Array<{ url: string; authorization?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url!, authorization: req.headers.authorization, body });
      if (req.url === '/redirect') { res.writeHead(302, { location: '/must-not-follow' }).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cli = (args: string[]) => run(process.execPath, ['--import', 'tsx', resolve(root, 'packages/agent-client/src/garage-cli.ts'), ...args], {
    env: { ...process.env, PNEU007_TOOL_TOKEN: tokens.business }, cwd: root, timeout: 5000,
  });
  try {
    const help = await cli(['--help']); assert.match(help.stdout, /private HTTP tools/); assert.ok(!help.stdout.includes(tokens.business));
    await assert.rejects(cli(['--url', base, 'call', 'GET', '/api/test']), /HTTPS is required/);
    const ok = await cli(['--url', base, '--allow-http-localhost', 'call', 'GET', '/api/test']); assert.deepEqual(JSON.parse(ok.stdout), { ok: true });
    const file = join(dir, 'request.json'); writeFileSync(file, '{"service_id":"wheel_swap"}');
    await cli(['--url', base, '--allow-http-localhost', 'call', 'POST', '/api/test', '--data-file', file]);
    assert.equal(received[1]!.body, '{"service_id":"wheel_swap"}');
    assert.ok(received.every(request => request.authorization === `Bearer ${tokens.business}`));
    await assert.rejects(cli(['--url', base, '--allow-http-localhost', 'call', 'GET', '//unknown.example/api']), /absolute path/);
    await assert.rejects(cli(['--url', base, '--allow-http-localhost', 'call', 'GET', '/redirect']), /fetch failed/);
    assert.ok(!received.some(request => request.url === '/must-not-follow'));
  } finally { await closeServer(server); rmSync(dir, { recursive: true, force: true }); }
});

test('site-only bootstrap and token-free demo conversations preserve private business and customer authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-public-demo-'));
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  const base = `http://127.0.0.1:${port}`;
  const cfg = config(dir, base);
  cfg.env.DEMO_PUBLIC_A2A = 'true';
  const system = await createUnifiedSystem(cfg);
  const server = system.app.listen(port, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  try {
    // Bootstrap remains discoverable before a business is activated or published.
    const home = await fetch(base);
    assert.match(home.headers.get('link') ?? '', /agents.md/);
    const guide = await (await fetch(`${base}/agents.md`)).text();
    for (const phrase of ['agent-registrations', 'setup-wakeup', 'ready:true', 'X-Demo-Session', 'independent approval', 'database', 'registry']) assert.ok(guide.includes(phrase), phrase);
    const manifest = await (await fetch(`${base}/.well-known/handle.json`)).json();
    assert.equal(manifest.instructions_url, `${base}/agents.md`);
    assert.equal(manifest.agent_entry_points.customer.demo_public_a2a, true);
    for (const path of ['/skills/handle-onboarding/SKILL.md', '/skills/pneu007-business/SKILL.md', '/skills/business-registry/SKILL.md', '/cli/inbox.mjs', '/cli/a2a.mjs']) assert.equal((await fetch(`${base}${path}`)).status, 200, path);
    const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) => fetch(`${base}/a2a/jsonrpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    });
    assert.equal((await rpc('SendMessage', {})).status, 503, 'public mode must not bypass inactive policy');
    const rules = system.policy.rulebooks;
    const proposed = rules.propose({ id: 'garage-demo', role: 'business_agent' }, fixtureProposal(rules.sources));
    rules.activate({ id: 'staff-owner', role: 'owner' }, proposed.version);
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
    system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    assert.deepEqual(card.securityRequirements ?? [], []);
    assert.deepEqual(card.securitySchemes ?? {}, {});
    assert.equal(card.documentationUrl, `${base}/agents.md`);
    assert.equal(card.capabilities.extensions[0].params.customer.demo_public_a2a, true);
    assert.match(await (await fetch(`${base}/llms.txt`)).text(), /No bearer token/);
    const sent = await rpc('SendMessage', { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic public demo: wheel swap estimate?' }] }, configuration: { returnImmediately: true } });
    assert.equal(sent.status, 200);
    const session = sent.headers.get('x-demo-session')!;
    assert.match(session, /^[a-f0-9-]{36}$/);
    const task = (await sent.json()).result.task;
    assert.ok(task.id, JSON.stringify(task));
    const same = await rpc('GetTask', { id: task.id }, { 'X-Demo-Session': session });
    assert.equal((await same.json()).result.id, task.id);
    const other = await rpc('GetTask', { id: task.id }, { 'X-Demo-Session': crypto.randomUUID() });
    assert.ok((await other.json()).error, 'a different demo session cannot read this task');
    assert.equal((await rpc('GetTask', { id: task.id }, { 'X-Demo-Session': 'customer-agent-a' })).status, 400);
    assert.equal((await rpc('GetTask', { id: task.id }, { authorization: 'Bearer invalid-token', 'X-Demo-Session': session })).status, 401);
    for (const path of ['/bot/inbox', '/bot/doorbell', '/api/agent/cases', '/api/audit/sources']) assert.equal((await fetch(`${base}${path}`, { headers: { 'X-Demo-Session': session } })).status, 401, path);
    let work: { owner: string; message_json: string } | undefined;
    for (let attempt = 0; attempt < 30 && !work; attempt++) {
      work = system.relay.db.sqlite.prepare('SELECT owner,message_json FROM work_items WHERE task_id=?').get(task.id) as typeof work;
      if (!work) await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(work?.owner, `demo:${session}`);
    assert.equal(JSON.parse(work!.message_json).authenticated_sender.acting_for, null);
    // The generic client needs no login and persists its session across invocations.
    // A stale saved bearer credential must not be sent to the public endpoint.
    const credentials = join(dir, 'public-client.json');
    writeFileSync(credentials, JSON.stringify({ [base]: 'invalid-unused-private-credential' }));
    const env = { ...process.env, A2A_CREDENTIALS_FILE: credentials };
    const cli = resolve(root, 'packages/agent-client/dist/a2a.mjs');
    const output = await run(process.execPath, [cli, 'send', base, 'Synthetic public CLI request', '--no-wait', '--json'], { env, timeout: 15_000 });
    const cliTask = JSON.parse(output.stdout);
    assert.ok(cliTask.id, output.stdout);
    const reread = await run(process.execPath, [cli, 'get', base, cliTask.id, '--json'], { env, timeout: 15_000 });
    assert.equal(JSON.parse(reread.stdout).id, cliTask.id);
    assert.ok(!output.stdout.includes('invalid-unused-private-credential'));
    writeFileSync(credentials, JSON.stringify({ [base]: tokens.a }));
    const authenticated = await run(process.execPath, [cli, 'send', base, 'Synthetic linked customer request', '--no-wait', '--authenticated', '--json'], { env, timeout: 15_000 });
    const linkedTask = JSON.parse(authenticated.stdout);
    const linkedRead = await run(process.execPath, [cli, 'get', base, linkedTask.id, '--authenticated', '--json'], { env, timeout: 15_000 });
    assert.equal(JSON.parse(linkedRead.stdout).id, linkedTask.id);
    let linkedWork: { owner: string; message_json: string } | undefined;
    for (let attempt = 0; attempt < 30 && !linkedWork; attempt++) {
      linkedWork = system.relay.db.sqlite.prepare('SELECT owner,message_json FROM work_items WHERE task_id=?').get(linkedTask.id) as typeof linkedWork;
      if (!linkedWork) await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(linkedWork?.owner, 'customer-agent-a');
    assert.equal(JSON.parse(linkedWork!.message_json).authenticated_sender.acting_for.id, 'customer-001');
  } finally { await closeServer(server); await system.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('demo chat yes approves only the exact owned offer and creates one locally simulated reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-chat-approval-'));
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port; await closeServer(probe);
  const base = `http://127.0.0.1:${port}`, cfg = config(dir, base);
  cfg.env.DEMO_PUBLIC_A2A = 'true'; cfg.env.DEMO_CHAT_APPROVAL = 'true';
  let externalCalls = 0;
  const external = async (): Promise<never> => { externalCalls++; throw new Error('External payments must never be reached'); };
  const system = await createUnifiedSystem(cfg, { paymentProvider: { name: 'masumi', start: external, observe: external, submitResult: external, requestRefund: external } });
  const server = system.app.listen(port, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const session = crypto.randomUUID(), other = crypto.randomUUID();
  const call = (path: string, body?: unknown, selected = session) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'X-Demo-Session': selected, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const service: ServiceSpec = { service_id: 'tyre_change', vehicle_type: 'personal', wheel_size_inches: 18, rim_type: 'alu', runflat: false, tpms: false, wheel_count: 4 };
  try {
    assert.equal((await call('/demo/cases', {})).status, 404);
    const rules = system.policy.rulebooks, proposed = rules.propose({ id: 'garage-demo', role: 'business_agent' }, fixtureProposal(rules.sources));
    rules.activate({ id: 'staff-owner', role: 'owner' }, proposed.version);
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
    system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const sent = await fetch(base + '/a2a/jsonrpc', { method: 'POST', headers: { 'X-Demo-Session': session, 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'demo-task', method: 'SendMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic chat approval workflow' }] }, configuration: { returnImmediately: true } } }) });
    const task = (await sent.json()).result.task;
    // Wait for SDK executor to persist ownership before correlation.
    for (let attempt = 0; attempt < 30 && !system.relay.db.sqlite.prepare('SELECT 1 FROM work_items WHERE task_id=?').get(task.id); attempt++) await new Promise(done => setTimeout(done, 20));
    assert.equal((await call('/demo/cases', { service_spec: service, relay_task_id: task.id }, other)).status, 403);
    const opened = await call('/demo/cases', { service_spec: service, relay_task_id: task.id }); assert.equal(opened.status, 201);
    const c = (await opened.json()).case;
    assert.equal(c.customer_agent_id, `demo:${session}`);
    const duplicate = await call('/demo/cases', { service_spec: service, relay_task_id: task.id }); assert.equal((await duplicate.json()).case.id, c.id);
    assert.equal((await call(`/demo/cases/${c.id}`, undefined, other)).status, 403);
    assert.equal((await call(`/demo/cases/${c.id}/approve`, { confirmation: 'yes_i_approve', simulation: true })).status, 400);
    const slot = system.store.availability({ service_id: service.service_id })[0]; assert.ok(slot);
    const quote = await fetch(`${base}/api/agent/cases/${c.id}/quotes`, { method: 'POST', headers: { authorization: `Bearer ${tokens.business}`, 'content-type': 'application/json' }, body: JSON.stringify({ slot_id: slot.id, discount_bps: 0 }) }); assert.equal(quote.status, 201, await quote.clone().text());
    const offer = await (await call(`/demo/cases/${c.id}`)).json(); assert.equal(offer.simulation, true); assert.ok(offer.slot.start_at);
    const approval = offer.approval_request;
    const demoActor: Actor = { id: `demo:${session}`, role: 'customer_agent', customer_id: c.customer_id };
    const competing = system.policy.createCase(demoActor, { service_spec: service });
    system.policy.quote({ id: 'garage-demo', role: 'business_agent' }, competing.id, { slot_id: slot.id, discount_bps: 0 });
    const competingApproval = (await (await call(`/demo/cases/${competing.id}`)).json()).approval_request;
    const ownerCase = system.policy.createCase(demoActor, { service_spec: service });
    system.policy.quote({ id: 'garage-demo', role: 'business_agent' }, ownerCase.id, { slot_id: slot.id, discount_bps: rules.getActive().params.auto_discount_bps + 1 });
    const ownerOffer = await (await call(`/demo/cases/${ownerCase.id}`)).json();
    assert.equal((await call(`/demo/cases/${ownerCase.id}/approve`, ownerOffer.approval_request)).status, 403, 'chat approval must not bypass owner discount consent');
    assert.equal((await call(`/demo/cases/${c.id}/approve`, { ...approval, confirmation: 'no' })).status, 403);
    for (const change of [{ total_minor: approval.total_minor + 1 }, { deposit_minor: 0 }, { slot_id: 'slot-other' }, { start_at: '2026-10-16T15:00:00Z' }, { quote_hash: 'wrong' }, { quote_version: 99 }]) assert.equal((await call(`/demo/cases/${c.id}/approve`, { ...approval, ...change })).status, 409);
    const result = await call(`/demo/cases/${c.id}/approve`, approval); assert.equal(result.status, 200, await result.clone().text());
    const booked = await result.json(); assert.equal(booked.booking.status, 'confirmed'); assert.equal(booked.actual_money_charged, false); assert.equal(booked.intent.provider, 'local_demo'); assert.equal(booked.intent.authorization.kind, 'demo_chat'); assert.equal(booked.independent_human_verification, false);
    const repeated = await (await call(`/demo/cases/${c.id}/approve`, approval)).json(); assert.equal(repeated.booking.id, booked.booking.id); assert.equal(repeated.intent.intent_id, booked.intent.intent_id);
    assert.equal((await call(`/demo/cases/${c.id}/approve`, { ...approval, total_minor: 1 })).status, 409);
    assert.equal((await call(`/demo/cases/${competing.id}/approve`, competingApproval)).status, 409, 'the same slot cannot be booked twice');
    assert.equal(system.store.calendar(c.customer_id).length, 1); assert.equal(system.store.listPaymentIntents().length, 1); assert.equal(externalCalls, 0);
    const intent = booked.intent;
    assert.throws(() => system.store.prepareCheckout(booked.order.id, { authorization: { ...intent.authorization, network: 'Preprod' }, provider: 'masumi', sku: intent.sku, asset_quantity: intent.asset_quantity, max_network_fee: '0', seller_id: intent.seller_id }), /local simulation/);
    assert.equal((await call('/api/agent/mandates', {})).status, 401, 'chat consent cannot approve a human mandate');
    cfg.env.DEMO_CHAT_APPROVAL = 'false'; assert.equal((await call(`/demo/cases/${c.id}`)).status, 404);
    cfg.env.DEMO_CHAT_APPROVAL = 'true';
    // Exercise the installed customer helper with the same persistent A2A session.
    const credentials = join(dir, 'cli.json');
    writeFileSync(credentials + '.demo-sessions.json', JSON.stringify({ [`${base}/a2a/jsonrpc`]: session }));
    const env = { ...process.env, A2A_CREDENTIALS_FILE: credentials }, cli = resolve(root, 'packages/agent-client/dist/a2a.mjs');
    const read = await run(process.execPath, [cli, 'demo-offer', base, c.id], { env, timeout: 15000 }); assert.equal(JSON.parse(read.stdout).booking.id, booked.booking.id);
    const approvalFile = join(dir, 'approval.json'); writeFileSync(approvalFile, JSON.stringify(approval));
    const approved = await run(process.execPath, [cli, 'demo-approve', base, c.id, '--data-file', approvalFile], { env, timeout: 15000 }); assert.equal(JSON.parse(approved.stdout).booking.id, booked.booking.id);
    assert.equal(externalCalls, 0);
  } finally { await closeServer(server); await system.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('open demo connects a fresh business bot with no login or proof and completes the customer booking loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-open-business-'));
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port; await closeServer(probe);
  const base = `http://127.0.0.1:${port}`, cfg = config(dir, base);
  cfg.env.DEMO_PUBLIC_A2A = 'true'; cfg.env.DEMO_CHAT_APPROVAL = 'true'; cfg.env.DEMO_OPEN_BUSINESS = 'true';
  let externalCalls = 0; const external = async (): Promise<never> => { externalCalls++; throw new Error('No external purchase is allowed'); };
  const system = await createUnifiedSystem(cfg, { paymentProvider: { name:'masumi',start:external,observe:external,submitResult:external,requestRefund:external } });
  const server = system.app.listen(port, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const session = crypto.randomUUID();
  const call = (path: string, body?: unknown, headers: Record<string,string> = {}) => fetch(base+path, { method:body === undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}) });
  const service: ServiceSpec = { service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4 };
  try {
    // Prepared rules are trusted test setup; the connecting agent performs no human login or onboarding.
    const rules=system.policy.rulebooks, proposed=rules.propose({id:'garage-demo',role:'business_agent'},fixtureProposal(rules.sources));
    rules.activate({id:'staff-owner',role:'owner'},proposed.version);
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));
    system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const manifest=await(await call('/.well-known/handle.json')).json();
    assert.equal(manifest.setup_mode,'open_demo'); assert.equal(manifest.owner_approval_required,false); assert.equal(manifest.pairing,undefined);
    const connected=await call('/demo-business/connect',{}); assert.equal(connected.status,200);
    const connection=await connected.json(); assert.equal(connection.authentication,'none'); assert.equal(connection.ownership_proof_required,false);
    for(const secret of Object.values(tokens))assert.ok(!JSON.stringify(connection).includes(secret));
    assert.equal((await call('/api/agent/cases')).status,401,'normal account-linked tools are unchanged');
    const privateCase=system.policy.createCase({id:'customer-agent-a',role:'customer_agent',customer_id:'customer-001'},{service_spec:service});
    assert.equal((await call(`/demo-business/cases/${privateCase.id}`)).status,404);
    const privateWork=system.relay.db.createWorkItem({task_id:crypto.randomUUID(),context_id:crypto.randomUUID(),owner:'customer-agent-a',customer_message_id:crypto.randomUUID(),message_json:'{}'});
    assert.equal((await(await call('/demo-business/bot/inbox')).json()).items.length,0);
    assert.equal(system.relay.db.getWorkItem(privateWork.id)?.status,'pending');
    assert.equal((await call('/demo-business/bot/reply',{work_item_id:privateWork.id,text:'not allowed',state:'completed'})).status,404);
    for(const path of ['/demo-business/bot/tasks/anything','/demo-business/orders/anything/checkout'])assert.equal((await call(path)).status,404);
    const taskResponse=await call('/a2a/jsonrpc',{jsonrpc:'2.0',id:'open-demo-task',method:'SendMessage',params:{message:{messageId:crypto.randomUUID(),role:'ROLE_USER',parts:[{text:'Synthetic open demo request'}]},configuration:{returnImmediately:true}}},{'X-Demo-Session':session,'A2A-Version':'1.0'});
    const task=(await taskResponse.json()).result.task; assert.ok(task.id);
    for(let n=0;n<30&&!system.relay.db.sqlite.prepare('SELECT 1 FROM work_items WHERE task_id=?').get(task.id);n++)await new Promise(done=>setTimeout(done,20));
    const opened=await call('/demo/cases',{relay_task_id:task.id,service_spec:service},{'X-Demo-Session':session}); assert.equal(opened.status,201);
    const c=(await opened.json()).case;
    const demoConfig=join(dir,'fresh-business.json'), env={...process.env,DEMO_BUSINESS_CONFIG:demoConfig}, cli=resolve(root,'packages/agent-client/dist/demo-business.mjs');
    const tool=async(args:string[])=>JSON.parse((await run(process.execPath,[cli,...args],{env,timeout:15000})).stdout);
    assert.equal((await tool(['connect','--url',base])).mode,'open_demo');
    assert.equal(JSON.parse(readFileSync(demoConfig,'utf8')).token,undefined);
    assert.equal((await tool(['rulebook'])).simulation,true);
    const inbox=await tool(['inbox']); assert.equal(inbox.items.length,1); assert.equal(inbox.items[0].task_id,task.id); assert.ok(inbox.items[0].lease_token);
    const available=await tool(['schedule','--service','tyre_change']); const slot=available.slots[0];assert.ok(slot);
    const quoteFile=join(dir,'quote.json');writeFileSync(quoteFile,JSON.stringify({slot_id:slot.id,discount_bps:0}));
    const quoted=await tool(['quote',c.id,'--data-file',quoteFile]); assert.ok(quoted.quote.id);
    assert.equal((await tool(['quote',c.id,'--data-file',quoteFile])).quote.id,quoted.quote.id,'quote retries must not create a second offer');
    const replyFile=join(dir,'reply.json');writeFileSync(replyFile,JSON.stringify({text:'Here is the fictional demo offer.',state:'input-required',data:{case_id:c.id,quote_id:quoted.quote.id}}));
    assert.equal((await tool(['reply',inbox.items[0].work_item_id,'--data-file',replyFile])).ok,true);
    const offer=await(await call(`/demo/cases/${c.id}`,undefined,{'X-Demo-Session':session})).json();
    const accepted=await call(`/demo/cases/${c.id}/approve`,offer.approval_request,{'X-Demo-Session':session}); assert.equal(accepted.status,200,await accepted.clone().text());
    const booked=await accepted.json();assert.equal(booked.booking.status,'confirmed');assert.equal(booked.intent.provider,'local_demo');assert.equal(booked.actual_money_charged,false);
    assert.equal((await tool(['order',booked.order.id])).booking.id,booked.booking.id);
    assert.equal((await tool(['reservations'])).reservations.length,1);
    assert.equal((await tool(['scheduled-check-in'])).available,false);assert.equal((await tool(['availability'])).mode,'scheduled');
    assert.equal(externalCalls,0);
    assert.equal((await(await call('/demo-business/cases')).json()).cases.length,1,'legacy account cases remain outside the open demo');
    cfg.env.DEMO_OPEN_BUSINESS='false';
    assert.equal((await call('/demo-business/connect',{})).status,404);assert.equal((await call('/demo-business/bot/inbox')).status,404);
    cfg.env.DEMO_OPEN_BUSINESS='true';cfg.env.HANDORU_FRESH='true';assert.equal((await call('/demo-business/connect',{})).status,404,'fresh production-style installations cannot use this facade');
  } finally { await closeServer(server); await system.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('prepared shop defaults to open business, public customer conversations and chat approval', () => {
  const dir=mkdtempSync(join(tmpdir(),'pneu-default-open-'));
  try {
    const env={...config(dir).env};
    delete env.DEMO_OPEN_BUSINESS; delete env.DEMO_PUBLIC_A2A; delete env.DEMO_CHAT_APPROVAL;
    const open=loadLegacyConfig(env);
    assert.equal(open.env.DEMO_OPEN_BUSINESS,'true');assert.equal(open.env.DEMO_PUBLIC_A2A,'true');assert.equal(open.env.DEMO_CHAT_APPROVAL,'true');
    assert.equal(unifiedRelayConfig(open).demoOpenBusiness,true);
    const protectedShop=loadLegacyConfig({...env,DEMO_OPEN_BUSINESS:'false'});
    assert.equal(protectedShop.env.DEMO_OPEN_BUSINESS,'false');assert.notEqual(protectedShop.env.DEMO_PUBLIC_A2A,'true');
    const fresh=loadLegacyConfig({...env,HANDLE_FRESH:'true'});
    assert.equal(fresh.env.DEMO_OPEN_BUSINESS,'false');assert.notEqual(fresh.env.DEMO_PUBLIC_A2A,'true');
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('native masked-secret handoff supports actual key links and private runtime bindings without a website form', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pneu-native-key-'));
  const probe=createServer();await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done));const port=(probe.address() as AddressInfo).port;await closeServer(probe);
  const base=`http://127.0.0.1:${port}`,cfg=config(dir,base);
  cfg.env.DEMO_PUBLIC_A2A='true';cfg.env.DEMO_CHAT_APPROVAL='true';cfg.env.DEMO_OPEN_BUSINESS='true';cfg.env.LEGACY_PUSH_HOST_ALLOWLIST='127.0.0.1';
  const calls:any[]=[];
  const hook=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{calls.push({body:JSON.parse(raw),authorization:req.headers.authorization});res.end(JSON.stringify({echo_key:req.headers.authorization}));});});
  await new Promise<void>(done=>hook.listen(0,'127.0.0.1',done));
  const callback=`http://127.0.0.1:${(hook.address() as AddressInfo).port}/native-webhook`;
  const settings='https://cursor.com/grok-bot/link/v1/sidebar?agent=test-agent&tab=routines&automation=pneu-test-routine&target=webhook-key',key='private-native-sender-key-for-tests-1234';
  const system=await createUnifiedSystem(cfg);const server=system.app.listen(port,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  try {
    const rules=system.policy.rulebooks,proposed=rules.propose({id:'garage-demo',role:'business_agent'},fixtureProposal(rules.sources));rules.activate({id:'staff-owner',role:'owner'},proposed.version);
    system.handoru.db.prepare("UPDATE handoru_connections SET state='active',scopes_json=? WHERE id='compatibility-pneu007'").run(JSON.stringify(ALL_SCOPES));system.handoru.db.prepare("UPDATE handoru_businesses SET active_connection_id='compatibility-pneu007',execution_epoch=1 WHERE id='pneu007'").run();
    const cli=resolve(root,'packages/agent-client/dist/demo-business.mjs'),file=join(dir,'business.json'),env={...process.env,DEMO_BUSINESS_CONFIG:file,PNEU_TEST_ROUTINE_SECRET:key};
    const tool=async(args:string[])=>{const result=await run(process.execPath,[cli,...args],{env,timeout:15000});assert.ok(!result.stdout.includes(key));assert.ok(!result.stderr.includes(key));return JSON.parse(result.stdout);};
    const connected=await tool(['connect','--url',base]);assert.equal(connected.next_action,'prepare_native_routine_then_request_handoff');
    const shortGuide=await(await fetch(base+'/agents.md')).text();assert.ok(shortGuide.length<5000);assert.ok(!shortGuide.includes('## Connection: fresh'));
    const shortSkill=await(await fetch(base+'/skills/pneu007-business/SKILL.md')).text();assert.ok(shortSkill.endsWith(shortGuide));assert.match(shortSkill,/name: pneu007-business/);
    const response=await fetch(connected.handoff_url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({routine_id:'pneu-test-routine'})});assert.equal(response.status,200);
    const handoff=await response.json();assert.deepEqual(handoff.requested_fields,['callback_url','webhook_key']);assert.equal(handoff.callback_known,false);assert.equal(new URL(handoff.key_settings_url).searchParams.get('automation'),'pneu-test-routine');assert.equal(new URL(handoff.key_settings_url).searchParams.get('target'),'webhook-key');assert.equal(handoff.user_message.split('. ').length<=2,true);
    assert.equal((await fetch(connected.handoff_url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({routine_id:'Pneu 007 display name'})})).status,400);
    const manifest=await(await fetch(base+'/.well-known/handle.json')).json();assert.equal(manifest.setup_mode,'open_demo');assert.equal(manifest.automatic_replies.mode,'webhook');assert.equal(manifest.automatic_replies.key_entry,'native_grok_masked_input');
    const setup=await tool(['webhook-setup','--callback-url',callback,'--key-settings-url',settings]);
    assert.equal(setup.key_settings_url,settings);assert.equal(setup.key_entry,'native_grok_masked_input');assert.equal(setup.setup_url,undefined);assert.equal(setup.callback_url,callback);
    assert.equal(setup.handoff_ready,true);assert.equal(new URL(setup.key_settings_url).searchParams.get('target'),'webhook-key');
    const derived=await tool(['webhook-setup','--callback-url',callback,'--agent-id','test-agent','--routine-id','pneu-test-routine']);assert.equal(derived.key_settings_url,setup.key_settings_url);assert.ok(derived.user_message.includes(derived.key_settings_url));
    await assert.rejects(run(process.execPath,[cli,'webhook-setup','--callback-url',callback,'--key-settings-url','https://cursor.com/grok-bot/link/v1/sidebar?agent=test-agent&tab=routines'],{env,timeout:15000}),/general Routines page is insufficient/);
    const incomplete=await tool(['webhook-setup','--routine-id','pneu-test-routine']);assert.equal(incomplete.callback_known,false);assert.equal(incomplete.scope,'current_bot');assert.deepEqual(incomplete.requested_fields,['callback_url','webhook_key']);assert.ok(incomplete.user_message.includes(incomplete.callback_settings_url));
    const installed=await tool(['set-webhook','--callback-url',callback,'--key-env','PNEU_TEST_ROUTINE_SECRET']);assert.equal(installed.test_ring.status,200);assert.equal(installed.wakeup.ready,false);
    assert.equal(calls[0].authorization,'Bearer '+key);
    await assert.rejects(run(process.execPath,[cli,'set-webhook','--callback-url',callback,'--key-env','MISSING_DEMO_SECRET'],{env,timeout:15000}),error=>{const e=error as {stdout:string;stderr:string};assert.ok(!e.stdout.includes(key));assert.ok(!e.stderr.includes(key));return /secure webhook key is unavailable/.test(e.stderr);});
    const keyFile=join(dir,'key.private');writeFileSync(keyFile,key,{mode:0o600});
    const fromFile=await tool(['set-webhook','--callback-url',callback,'--key-file',keyFile]);assert.equal(fromFile.test_ring.status,200);
    const eventFile=join(dir,'actual-event.json');writeFileSync(eventFile,JSON.stringify(calls.at(-1).body),{mode:0o600});
    assert.equal((await tool(['acknowledge-wakeup','--event-file',eventFile])).ready,true);
    assert.equal((await tool(['acknowledge-wakeup','--event-file',eventFile])).ready,true);
    assert.equal((await tool(['availability'])).mode,'webhook');
    assert.ok(!readFileSync(file,'utf8').includes(key));
    assert.ok(!JSON.stringify(system.relay.db.listEvents({})).includes(key));
  } finally {await closeServer(server);await closeServer(hook);await system.close();rmSync(dir,{recursive:true,force:true});}
});
