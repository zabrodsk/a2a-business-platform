import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskState, type Task } from '@a2a-js/sdk';
import type { AddressInfo } from 'node:net';
import type { AcceptedReply, Config, Identity } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { createRelay } from '../src/server.js';
import { agentMessage } from '../src/a2a-helpers.js';
import { ownerContext } from '../src/executor.js';
import { identify } from '../src/auth.js';

let blankDb: string;
const root = resolve(import.meta.dirname, '../../..');
const customerToken = 'customer-token-for-managed-tests';
const businessToken = 'business-token-for-managed-tests';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
before(() => {
  blankDb = join(mkdtempSync(join(tmpdir(), 'managed-relay-base-')), 'blank.db');
  const result = spawnSync('npx', ['a2a-db', 'upgrade', '--url', `sqlite:${blankDb}`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

async function fixture(businessId = 'firm-a', authority = new Map<string, AcceptedReply>()) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'managed-relay-')), 'relay.db');
  copyFileSync(blankDb, dbPath);
  let connection = 'connection-a';
  let epoch = 1;
  let active = true;
  let credentialValid = true;
  const currentIdentity = (): Identity => ({ id: connection, role: 'business', business_id: businessId,
    connection_id: connection, execution_epoch: epoch, scopes: ['inbox.read', 'inbox.reply', 'doorbell.write', 'tasks.read'] });
  const cfg: Config = {
    ...loadConfig({ BUSINESS_TOKEN: businessToken, DB_PATH: dbPath, REPLY_WAIT_MS: '50', PUSH_HOST_ALLOWLIST: '127.0.0.1' }),
    businessId, a2aPath: '/a2a', isActive: () => active,
    lookupToken: (token) => token === customerToken ? { id: 'same-customer', role: 'customer' }
      : token === businessToken && credentialValid ? currentIdentity() : undefined,
    checkIdentity: (identity, operation) => identity.role === 'customer' || (identity.business_id === businessId
      && identity.connection_id === connection && identity.execution_epoch === epoch
      && (!operation || identity.scopes?.includes(operation) === true)),
    acceptReply: (record) => {
      if (!authority.has(record.work_item_id)) authority.set(record.work_item_id, structuredClone(record));
      return authority.get(record.work_item_id)!;
    },
    pendingReplies: () => [...authority.values()],
    markReplyDelivered: (id) => { authority.delete(id); },
  };
  let relay = createRelay(cfg);
  const server = relay.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, token = businessToken) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const newTask = async (taskId = crypto.randomUUID()) => {
    const contextId = crypto.randomUUID();
    const task: Task = { id: taskId, contextId, artifacts: [], metadata: {}, status: {
      state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined,
    }, history: [] };
    // Save an SDK-owned customer task without relying on a long-lived request.
    const { DatabaseTaskStore } = await import('@a2a-js/sdk/server/database');
    await new DatabaseTaskStore(relay.db.kysely).save(task, ownerContext('same-customer'));
    const item = relay.db.createWorkItem({ task_id: taskId, context_id: contextId, owner: 'same-customer',
      customer_message_id: crypto.randomUUID(), message_json: '{"text":"test request","from":"customer"}' });
    return { task, item };
  };
  return { cfg, base, call, newTask, currentIdentity, authority, get relay() { return relay; },
    cutover() { connection = 'connection-b'; epoch++; }, revokeCredential() { credentialValid = false; }, setActive(value: boolean) { active = value; },
    async restart() {
      await new Promise<void>((r) => server.close(() => r()));
      await relay.close();
      relay = createRelay(cfg);
    },
    async close() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await relay.close(); },
  };
}

test('authoritative token lookup never resurrects a revoked environment token', () => {
  const cfg = loadConfig({ BUSINESS_TOKEN: businessToken });
  cfg.lookupToken = () => undefined;
  assert.equal(identify(cfg, `Bearer ${businessToken}`), undefined);
});

test('managed claims fence missing/expired leases and old epochs; B can resume the same task', async () => {
  const f = await fixture();
  try {
    const { item } = await f.newTask();
    const a = (await (await f.call('/bot/inbox')).json()).items[0];
    assert.equal(a.work_item_id, item.id);
    assert.equal(a.connection_id, 'connection-a');
    assert.equal((await f.call('/bot/reply', { work_item_id: item.id, text: 'missing lease' })).status, 409);
    const oldIdentity = f.currentIdentity();
    f.cutover();
    await assert.rejects(f.relay.executor.submitReply(item, { state: TaskState.TASK_STATE_COMPLETED,
      message: agentMessage(item.task_id, item.context_id, 'old reply') }, oldIdentity,
      { token: a.lease_token, generation: a.claim_generation }), /no longer authorized/);
    const b = (await (await f.call('/bot/inbox')).json()).items[0];
    assert.equal(b.work_item_id, item.id);
    assert.equal(b.claim_generation, a.claim_generation + 1);
    assert.equal((await f.call('/bot/reply', { work_item_id: item.id, text: 'stale lease',
      lease_token: a.lease_token, claim_generation: a.claim_generation })).status, 409);
    f.relay.db.sqlite.prepare('UPDATE work_items SET lease_until = ? WHERE id = ?').run(Date.now() - 1, item.id);
    assert.equal((await f.call('/bot/reply', { work_item_id: item.id, text: 'expired lease',
      lease_token: b.lease_token, claim_generation: b.claim_generation })).status, 409);
    const c = (await (await f.call('/bot/inbox')).json()).items[0];
    const accepted = await f.call('/bot/reply', { work_item_id: item.id, text: 'B finished', state: 'completed',
      lease_token: c.lease_token, claim_generation: c.claim_generation });
    assert.equal(accepted.status, 200);
    const task = await f.relay.executor.loadForOwner('same-customer', item.task_id);
    assert.equal(task?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(task?.artifacts.length, 1);
    assert.equal(f.authority.size, 0);
  } finally { await f.close(); }
});

test('long-poll rechecks captured connection identity after handover and does not claim new work', async () => {
  const f = await fixture();
  try {
    const waiting = f.call('/bot/wait?timeout=1');
    await sleep(50);
    f.cutover();
    const { item } = await f.newTask();
    f.relay.doorbell.signal.emit('work');
    assert.equal((await waiting).status, 403);
    assert.equal(f.relay.db.getWorkItem(item.id)?.status, 'pending');
  } finally { await f.close(); }
});

test('same customer is isolated across managed databases for task read, inbox and reply', async () => {
  const a = await fixture('firm-a');
  const b = await fixture('firm-b');
  try {
    const { item } = await a.newTask();
    assert.equal((await b.call(`/bot/tasks/${item.task_id}`)).status, 404);
    assert.deepEqual((await (await b.call('/bot/inbox')).json()).items, []);
    assert.equal((await b.call('/bot/reply', { work_item_id: item.id, text: 'wrong firm' })).status, 404);
    assert.equal(b.relay.db.getWorkItem(item.id), undefined);
  } finally { await a.close(); await b.close(); }
});

test('inactive managed relay exposes neither card nor public transaction endpoint', async () => {
  const f = await fixture();
  try {
    f.setActive(false);
    assert.equal((await fetch(`${f.base}/.well-known/agent-card.json`)).status, 404);
    assert.equal((await f.call('/a2a', {}, customerToken)).status, 409);
  } finally { await f.close(); }
});

test('authority acceptance survives failure before relay commit and replays one full reply after restart', async () => {
  const f = await fixture();
  try {
    const { item } = await f.newTask();
    const claim = (await (await f.call('/bot/inbox')).json()).items[0];
    const realStore = f.relay.db.storeAcceptedReply.bind(f.relay.db);
    f.relay.db.storeAcceptedReply = () => { throw new Error('simulated crash after authority commit'); };
    const message = agentMessage(item.task_id, item.context_id, 'durable final reply', { booking_id: 'keep-original-booking' });
    await assert.rejects(f.relay.executor.submitReply(item, { state: TaskState.TASK_STATE_COMPLETED, message },
      f.currentIdentity(), { token: claim.lease_token, generation: claim.claim_generation }), /simulated crash/);
    assert.equal(f.authority.size, 1);
    const stableMessageId = [...f.authority.values()][0].message_id;
    assert.equal(f.relay.db.getWorkItem(item.id)?.status, 'claimed');
    f.relay.db.storeAcceptedReply = realStore;
    await f.restart();
    await f.relay.executor.replayReplies();
    const task = await f.relay.executor.loadForOwner('same-customer', item.task_id);
    assert.equal(task?.status?.message?.messageId, stableMessageId);
    assert.match(JSON.stringify(task?.status?.message), /keep-original-booking/);
    assert.equal(task?.artifacts.length, 1);
    assert.equal(f.relay.db.getWorkItem(item.id)?.status, 'done');
    assert.equal(f.authority.size, 0);
    await f.relay.executor.replayReplies();
    const again = await f.relay.executor.loadForOwner('same-customer', item.task_id);
    assert.equal(again?.artifacts.length, 1);
    assert.equal(again?.status?.message?.messageId, stableMessageId);
  } finally { await f.close(); }
});

test('a lost acknowledgement after SDK persistence recovers a live blocking reply without duplication', async () => {
  const f = await fixture();
  try {
    f.cfg.replyWaitMs = 2000;
    const acknowledge = f.cfg.markReplyDelivered;
    f.cfg.markReplyDelivered = () => { throw new Error('simulated crash before authority acknowledgement'); };
    const customer = f.call('/a2a', { jsonrpc: '2.0', id: 'live', method: 'SendMessage', params: {
      message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'book tyres' }] },
      configuration: { returnImmediately: false },
    } }, customerToken);
    let claim: any;
    for (let attempt = 0; attempt < 50 && !claim; attempt++) {
      const inbox = await (await f.call('/bot/inbox')).json();
      claim = inbox.items[0];
      if (!claim) await sleep(10);
    }
    assert.ok(claim, 'live task must reach the managed inbox');
    const submitted = await f.call('/bot/reply', { work_item_id: claim.work_item_id, text: 'one durable live booking',
      state: 'completed', data: { booking_id: 'original-live-booking' }, lease_token: claim.lease_token,
      claim_generation: claim.claim_generation });
    assert.equal(submitted.status, 200);
    assert.match(JSON.stringify(await (await customer).json()), /one durable live booking/);
    const before = await f.relay.executor.loadForOwner('same-customer', claim.task_id);
    const messageId = before?.status?.message?.messageId;
    assert.equal(f.authority.size, 1);
    f.cfg.markReplyDelivered = acknowledge;
    await f.restart();
    await f.relay.executor.replayReplies();
    const after = await f.relay.executor.loadForOwner('same-customer', claim.task_id);
    assert.equal(after?.status?.message?.messageId, messageId);
    assert.equal(after?.artifacts.length, 1);
    assert.equal(after?.history.filter((m) => m.messageId === messageId).length, before?.history.filter((m) => m.messageId === messageId).length);
    assert.ok(after!.history.filter((m) => m.messageId === messageId).length <= 1);
    assert.equal(f.authority.size, 0);
  } finally { await f.close(); }
});

test('accepted late reply survives SDK persistence failure and is never offered to the replacement', async () => {
  const f = await fixture();
  try {
    const { item } = await f.newTask();
    const claim = (await (await f.call('/bot/inbox')).json()).items[0];
    const taskStore = (f.relay.executor as unknown as { taskStore: { save: (...args: any[]) => Promise<void> } }).taskStore;
    const save = taskStore.save;
    taskStore.save = async () => { throw new Error('simulated crash before SDK save'); };
    await assert.rejects(f.relay.executor.submitReply(item, { state: TaskState.TASK_STATE_COMPLETED,
      message: agentMessage(item.task_id, item.context_id, 'persist this entire late payload', { booking_id: 'late-original' }) },
      f.currentIdentity(), { token: claim.lease_token, generation: claim.claim_generation }), /simulated crash/);
    assert.equal(f.relay.db.getWorkItem(item.id)?.status, 'done');
    assert.match(f.relay.db.getWorkItem(item.id)!.reply_json!, /late-original/);
    f.cutover();
    assert.deepEqual((await (await f.call('/bot/inbox')).json()).items, []);
    taskStore.save = save;
    await f.restart();
    await f.relay.executor.replayReplies();
    const after = await f.relay.executor.loadForOwner('same-customer', item.task_id);
    assert.match(JSON.stringify(after?.status?.message), /late-original/);
    assert.equal(after?.artifacts.length, 1);
  } finally { await f.close(); }
});

test('doorbell registration is tied to the connection, and handover stops using its hook', async () => {
  const f = await fixture();
  try {
    const configured = await f.call('/bot/doorbell', { url: 'http://127.0.0.1:1/hook', key: 'private-hook-token' });
    assert.equal(configured.status, 200);
    assert.equal(f.relay.doorbell.webhook()?.key, 'private-hook-token');
    f.cutover();
    assert.equal(f.relay.doorbell.webhook(), undefined);
    assert.equal(f.relay.db.listEvents({}).some((event) => JSON.stringify(event).includes('private-hook-token')), false);
  } finally { await f.close(); }
});

test('managed scheduler allows only one outstanding claim per business runtime', async () => {
  const f = await fixture();
  try {
    await f.newTask();
    await f.newTask();
    const first = (await (await f.call('/bot/inbox')).json()).items;
    assert.equal(first.length, 1);
    assert.deepEqual((await (await f.call('/bot/inbox')).json()).items, []);
    const reply = await f.call('/bot/reply', { work_item_id: first[0].work_item_id,
      text: 'first finished', state: 'completed', lease_token: first[0].lease_token,
      claim_generation: first[0].claim_generation });
    assert.equal(reply.status, 200);
    const next = (await (await f.call('/bot/inbox')).json()).items;
    assert.equal(next.length, 1);
    assert.notEqual(next[0].work_item_id, first[0].work_item_id);
  } finally { await f.close(); }
});

test('credential rotation alone cancels an open long-poll on the same active connection', async () => {
  const f = await fixture();
  try {
    const waiting = f.call('/bot/wait?timeout=1');
    await sleep(50);
    f.revokeCredential();
    const { item } = await f.newTask();
    f.relay.doorbell.signal.emit('work');
    assert.equal((await waiting).status, 403);
    assert.equal(f.relay.db.getWorkItem(item.id)?.status, 'pending');
  } finally { await f.close(); }
});

test('initial SDK progress saves cannot acknowledge or erase an already accepted live reply', async () => {
  const f = await fixture();
  try {
    const { task, item } = await f.newTask();
    const message = agentMessage(item.task_id, item.context_id, 'preserve across queued WORKING events');
    const record: AcceptedReply = { work_item_id: item.id, task_id: item.task_id, context_id: item.context_id,
      owner: item.owner, business_id: 'firm-a', message_id: message.messageId,
      reply: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message } };
    f.authority.set(item.id, record);
    f.relay.db.storeAcceptedReply(record);
    const taskStore = (f.relay.executor as unknown as { taskStore: { save: (task: Task, context: ReturnType<typeof ownerContext>) => Promise<void> } }).taskStore;
    for (let event = 0; event < 2; event++) {
      task.status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() };
      await taskStore.save(task, ownerContext(item.owner));
      assert.equal(f.authority.size, 1, 'progress save must leave delivery intent pending');
      assert.equal(f.relay.db.pendingReplies().length, 1);
      assert.equal((await f.relay.executor.loadForOwner(item.owner, item.task_id))?.status?.message?.messageId, message.messageId);
    }
    task.status = { state: TaskState.TASK_STATE_INPUT_REQUIRED, message, timestamp: new Date().toISOString() };
    await taskStore.save(task, ownerContext(item.owner));
    assert.equal(f.authority.size, 0);
    assert.equal(f.relay.db.pendingReplies().length, 0);
    task.status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() };
    await taskStore.save(task, ownerContext(item.owner));
    assert.equal((await f.relay.executor.loadForOwner(item.owner, item.task_id))?.status?.message?.messageId, message.messageId,
      'a delayed progress event after acknowledgement must not erase the reply');
  } finally { await f.close(); }
});

test('one-time native compatibility migration preserves work/task/reply IDs and refuses arbitrary rebinding', async () => {
  const { RelayDb } = await import('../src/db.js');
  const file = join(mkdtempSync(join(tmpdir(), 'relay-native-migration-')), 'relay.db');
  let db = new RelayDb(file);
  const item = db.createWorkItem({ task_id: 'original-task', context_id: 'original-context', owner: 'same-customer',
    customer_message_id: 'original-customer-message', message_json: '{"text":"original request"}' });
  const message = agentMessage(item.task_id, item.context_id, 'original accepted reply');
  db.storeAcceptedReply({ work_item_id: item.id, task_id: item.task_id, context_id: item.context_id,
    owner: item.owner, business_id: 'standalone', message_id: message.messageId,
    reply: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message } });
  await db.kysely.destroy();
  db = new RelayDb(file, 'pneu007');
  assert.equal(db.getWorkItem(item.id)?.task_id, 'original-task');
  assert.equal(db.getWorkItem(item.id)?.business_id, 'pneu007');
  assert.equal(db.pendingReplies()[0].message_id, message.messageId);
  assert.equal(db.pendingReplies()[0].business_id, 'pneu007');
  await db.kysely.destroy();
  db = new RelayDb(file, 'pneu007');
  assert.equal(db.getWorkItem(item.id)?.customer_message_id, 'original-customer-message');
  await db.kysely.destroy();
  assert.throws(() => new RelayDb(file, 'other-business'), /another business/);
  assert.throws(() => new RelayDb(file), /another business/);
});

test('compatibility webhook migration preserves a trusted hook once and cannot resurrect it after cutover/restart', async () => {
  const { RelayDb } = await import('../src/db.js');
  const { Doorbell } = await import('../src/doorbell.js');
  const file = join(mkdtempSync(join(tmpdir(), 'relay-webhook-migration-')), 'relay.db');
  let epoch = 1, active = true;
  const identity: Identity = { id: 'legacy-business-principal', role: 'business', business_id: 'pneu007',
    connection_id: 'compatibility-pneu007', execution_epoch: 1, scopes: ['doorbell.write'] };
  const cfg: Config = { ...loadConfig({ BUSINESS_TOKEN: businessToken }), businessId: 'pneu007',
    businessWebhook: { url: 'https://hooks.example/env-fallback', key: 'env-hook-private-key' }, pushHostAllowlist: ['hooks.example'],
    checkIdentity: (actor, operation) => active && actor.id === identity.id && actor.business_id === 'pneu007'
      && actor.connection_id === 'compatibility-pneu007' && actor.execution_epoch === epoch && operation === 'doorbell.write',
  };
  let db = new RelayDb(file, 'pneu007');
  let doorbell = new Doorbell(cfg, db);
  db.setSetting('business_webhook', JSON.stringify({ url: 'https://hooks.example/stored-hook', key: 'stored-hook-private-key' }));
  assert.equal(doorbell.webhook(), undefined, 'Unbound managed hooks remain disabled before explicit migration');
  assert.equal(doorbell.migrateCompatibilityWebhook(identity), true);
  assert.equal(doorbell.webhook()?.url, 'https://hooks.example/stored-hook', 'Stored trusted hook wins over env');
  assert.equal(JSON.parse(db.getSetting('business_webhook')!).identity.connection_id, 'compatibility-pneu007');
  assert.equal(doorbell.migrateCompatibilityWebhook(identity), false);
  epoch = 2;
  assert.equal(doorbell.webhook(), undefined, 'Old epoch no longer authorizes wakeups');
  assert.equal(doorbell.migrateCompatibilityWebhook({ ...identity, execution_epoch: 2 }), false, 'Marker forbids rebinding to a later epoch');
  active = false;
  await db.kysely.destroy();
  db = new RelayDb(file, 'pneu007');doorbell = new Doorbell(cfg, db);
  try {
    assert.equal(doorbell.webhook(), undefined);
    assert.equal(doorbell.migrateCompatibilityWebhook(identity), false);
    db.setSetting('business_webhook', undefined);
    active = true;
    assert.equal(doorbell.migrateCompatibilityWebhook({ ...identity, execution_epoch: 2 }), false);
    assert.equal(doorbell.webhook(), undefined, 'Env fallback must not resurrect a cleared/revoked hook');
    assert.ok(!JSON.stringify(db.listEvents({})).includes('private-key'));
  } finally { await db.kysely.destroy(); }
});

test('compatibility webhook binding requires live native compatibility identity and never replaces an already-bound hook', async () => {
  const { RelayDb } = await import('../src/db.js');
  const { Doorbell } = await import('../src/doorbell.js');
  const db = new RelayDb(':memory:', 'pneu007');
  const identity: Identity = { id: 'legacy-business-principal', role: 'business', business_id: 'pneu007',
    connection_id: 'compatibility-pneu007', execution_epoch: 1, scopes: ['doorbell.write'] };
  const cfg: Config = { ...loadConfig({ BUSINESS_TOKEN: businessToken }), businessId: 'pneu007',
    businessWebhook: { url: 'https://hooks.example/approved', key: 'approved-hook-private-key' }, pushHostAllowlist: ['hooks.example'],
    checkIdentity: actor => actor.id === identity.id && actor.connection_id === identity.connection_id && actor.execution_epoch === 1,
  };
  const doorbell = new Doorbell(cfg, db);
  try {
    for (const actor of [{ ...identity, role: 'customer' as const }, { ...identity, business_id: 'other-firm' },
      { ...identity, connection_id: 'arbitrary-connection' }, { ...identity, execution_epoch: undefined },
      { ...identity, id: 'forged-principal' }]) assert.equal(doorbell.migrateCompatibilityWebhook(actor), false);
    assert.equal(db.getSetting('compatibility_webhook_migrated:pneu007:v1'), undefined);
    const previouslyBound = JSON.stringify({ url: 'https://hooks.example/current', key: 'current-hook-private-key', identity: { ...identity, connection_id: 'new-runtime' } });
    db.setSetting('business_webhook', previouslyBound);
    assert.equal(doorbell.migrateCompatibilityWebhook(identity), false);
    assert.equal(db.getSetting('business_webhook'), previouslyBound, 'Existing bound hook must remain untouched');
  } finally { await db.kysely.destroy(); }
  const envDb = new RelayDb(':memory:', 'pneu007');
  try {
    const envDoorbell = new Doorbell(cfg, envDb);
    assert.equal(envDoorbell.migrateCompatibilityWebhook(identity), true, 'Trusted env hook can be imported once when no stored setting exists');
    assert.equal(envDoorbell.webhook()?.key, 'approved-hook-private-key');
  } finally { await envDb.kysely.destroy(); }
});

test('compatibility webhook migration validates allowed HTTPS/local hosts and fails closed without an authority resolver', async () => {
  const { RelayDb } = await import('../src/db.js');
  const { Doorbell } = await import('../src/doorbell.js');
  const identity: Identity = { id: 'legacy-business-principal', role: 'business', business_id: 'pneu007', connection_id: 'compatibility-pneu007', execution_epoch: 1 };
  for (const url of ['https://untrusted.example/hook','http://hooks.example/insecure','https://name:password@hooks.example/hook','file:///hook']) {
    const db = new RelayDb(':memory:', 'pneu007');
    try {
      const cfg: Config = { ...loadConfig({ BUSINESS_TOKEN: businessToken }), businessId: 'pneu007', pushHostAllowlist: ['hooks.example'],
        businessWebhook: { url, key: 'private-hook-test-key' }, checkIdentity: () => true };
      assert.equal(new Doorbell(cfg,db).migrateCompatibilityWebhook(identity), false);
      assert.equal(db.getSetting('business_webhook'), undefined);
      cfg.businessWebhook = { url: 'https://hooks.example/now-valid', key: 'private-hook-test-key' };
      assert.equal(new Doorbell(cfg,db).migrateCompatibilityWebhook(identity), false, 'A later env change must not retry a rejected migration');
    } finally { await db.kysely.destroy(); }
  }
  const db = new RelayDb(':memory:', 'pneu007');
  try {
    const cfg: Config = { ...loadConfig({ BUSINESS_TOKEN: businessToken }), businessId: 'pneu007',
      pushHostAllowlist: ['127.0.0.1'], businessWebhook: { url: 'http://127.0.0.1/hook', key: 'local-hook-test-key' } };
    assert.equal(new Doorbell(cfg,db).migrateCompatibilityWebhook(identity), false, 'Missing live authority resolver is not approval');
    cfg.checkIdentity = () => true;
    assert.equal(new Doorbell(cfg,db).migrateCompatibilityWebhook(identity), true);
  } finally { await db.kysely.destroy(); }
});
