// These scripted principals are transport regression fixtures, not proof of real GrokBot access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { ALL_SCOPES } from '../src/handoru/store.js';
import type { Actor } from '../../../packages/contracts/index.js';
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
    assert.equal(cardJson.documentationUrl, `${base}/auth.md`);
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
