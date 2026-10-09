import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LegacyStore } from '../../../packages/demo-garage/index.js';
import { HandoruStore, AUDIT_SCOPES, hash } from '../src/handoru/store.js';
import { provisionRelay } from '../src/handoru/onboarding.js';

const origin = 'https://pneu007.example';
const setupCredential = 'handoru-human-setup-test-only';
const password = 'test-only owner passphrase';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'handoru-onboarding-'));
  const file = join(dir, 'legacy.sqlite');
  let instant = new Date('2026-10-09T08:00:00Z');
  const now = () => instant;
  let legacy = new LegacyStore(file, { now });
  let handoru = new HandoruStore(legacy.db, origin, now);
  t.after(() => { legacy.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get legacy() { return legacy; }, get h() { return handoru; },
    file,
    advance(ms: number) { instant = new Date(instant.getTime() + ms); },
    restart() { legacy.close(); legacy = new LegacyStore(file, { now }); handoru = new HandoruStore(legacy.db, origin, now); },
  };
}
function owner(h: HandoruStore) {
  return h.signup('OWNER@example.com', password, setupCredential, setupCredential);
}
function request(h: HandoruStore, runtime = 'test-runtime-A') {
  return h.register({ runtime, legacy_url: origin });
}
function publishProof(h: HandoruStore, challenge: string) {
  // Test fixture represents the separately authorized legacy website operation.
  h.db.prepare("INSERT INTO handoru_meta VALUES('ownership_proof',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ challenge }));
}

test('populated legacy starts without a Handle firm, connection, relay, credential or owner', t => {
  const f = fixture(t);
  assert.ok(f.legacy.listOrders().length > 0, 'Legacy fixture data must remain available on day one');
  assert.equal(f.h.installation(), undefined);
  for (const table of ['handoru_businesses', 'handoru_owners', 'handoru_connections', 'handoru_credentials', 'handoru_relays']) {
    assert.equal((f.h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
});

test('first human signup requires a separate setup credential; legacy or agent access cannot establish the realm', t => {
  const f = fixture(t);
  for (const supplied of [undefined, 'legacy-admin-password', 'business-agent-token']) {
    assert.throws(() => f.h.signup('owner@example.com', password, supplied, setupCredential), { code: 'OWNER_SETUP_REQUIRED' });
  }
  assert.throws(() => f.h.signup('owner@example.com', password, setupCredential, undefined), { code: 'OWNER_SETUP_REQUIRED' });
  const human = owner(f.h);
  assert.equal(human.email, 'owner@example.com');
  assert.deepEqual(f.h.login('Owner@Example.com', password), human);
  assert.throws(() => f.h.signup('another@example.com', password, setupCredential, setupCredential), { code: 'OWNER_EXISTS' });
  assert.throws(() => f.h.login('owner@example.com', 'legacy-admin-password'), { code: 'INVALID_LOGIN' });
  assert.equal(f.h.installation(), undefined, 'Human signup must not seed a business');
});

test('human sessions use only the Handle cookie, expire, and persist as token hashes', t => {
  const f = fixture(t), human = owner(f.h), session = f.h.session(human);
  assert.equal(f.h.identifyHuman(`legacy_session=${session.token}`), undefined);
  assert.equal(f.h.identifyHuman(`session=${session.token}`), undefined);
  assert.equal(f.h.identifyHuman(`handoru_session=${session.token}`)?.owner.id, human.id);
  assert.equal(f.h.identifyHuman(`other=x; handoru_session=${session.token}; other2=y`)?.csrf, session.csrf);
  const persisted = JSON.stringify(f.h.db.prepare('SELECT * FROM handoru_sessions').all());
  assert.ok(!persisted.includes(session.token));
  f.restart();
  assert.equal(f.h.identifyHuman(`handoru_session=${session.token}`)?.owner.id, human.id);
  f.advance(12 * 60 * 60_000);
  assert.equal(f.h.identifyHuman(`handoru_session=${session.token}`), undefined);
});

test('registration confines claims to the native website origin and gives provisional access no firm authority', t => {
  const f = fixture(t);
  for (const url of ['https://other.example', 'https://u:p@pneu007.example', `${origin}/?token=x`, `${origin}/#x`]) {
    assert.throws(() => f.h.register({ runtime: 'test', legacy_url: url }));
  }
  const pending = request(f.h);
  assert.equal(f.h.identify(pending.provisional_credential), undefined);
  assert.equal(f.h.onboarding(pending.request_id, pending.provisional_credential).state, 'pending');
  assert.throws(() => f.h.exchange(pending.request_id, pending.provisional_credential), { code: 'AUTHORIZATION_PENDING' });
  assert.throws(() => f.h.onboarding(pending.request_id, 'another-provisional-credential'), { code: 'ONBOARDING_UNAVAILABLE' });
  assert.equal(f.h.installation(), undefined);
  const persisted = JSON.stringify(f.h.db.prepare('SELECT * FROM handoru_onboarding').all());
  assert.ok(!persisted.includes(pending.provisional_credential));
  assert.ok(!persisted.includes(`"user_code":"${pending.user_code}"`));
});

test('owner consent requires the exact website ownership challenge and cannot grant operational scopes early', t => {
  const f = fixture(t), human = owner(f.h), first = request(f.h), second = request(f.h, 'test-runtime-B');
  publishProof(f.h, second.ownership_challenge.challenge);
  assert.throws(() => f.h.decide(human, first.request_id, first.user_code, 'approved', AUDIT_SCOPES), { code: 'OWNERSHIP_PROOF_REQUIRED' });
  assert.equal(f.h.installation(), undefined);
  publishProof(f.h, first.ownership_challenge.challenge);
  assert.throws(() => f.h.decide(human, first.request_id, first.user_code, 'approved', ['orders.checkout']), { code: 'INVALID_SCOPES' });
  const approved = f.h.decide(human, first.request_id, first.user_code, 'approved', AUDIT_SCOPES);
  assert.equal(approved.state, 'approved');
  assert.ok(approved.business_id);
  const issued = f.h.exchange(first.request_id, first.provisional_credential);
  const actor = f.h.identify(issued.access_token)!;
  assert.equal(actor.role, 'business_agent');
  assert.equal(actor.business_id, approved.business_id);
  assert.equal(actor.id, first.principal_id);
  assert.throws(() => f.h.authorize(actor, approved.business_id!, 'orders.checkout', true));
  assert.throws(() => f.h.member({ id: first.principal_id, email: 'bot@example.com' }, approved.business_id!), { code: 'FORBIDDEN' });
});

test('pairing attempts lock after five failures and an expired correct code creates no business', t => {
  const f = fixture(t), human = owner(f.h), pending = request(f.h);
  const wrong = pending.user_code === '000000' ? '000001' : '000000';
  publishProof(f.h, pending.ownership_challenge.challenge);
  for (let n = 0; n < 5; n++) assert.throws(() => f.h.decide(human, pending.request_id, wrong, 'approved', AUDIT_SCOPES), { code: 'PAIRING_CODE_INVALID' });
  assert.throws(() => f.h.decide(human, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES), { code: 'ONBOARDING_UNAVAILABLE' });
  const expired = request(f.h);
  publishProof(f.h, expired.ownership_challenge.challenge);
  f.advance(15 * 60_000);
  assert.throws(() => f.h.decide(human, expired.request_id, expired.user_code, 'approved', AUDIT_SCOPES), { code: 'ONBOARDING_UNAVAILABLE' });
  assert.throws(() => f.h.exchange(expired.request_id, expired.provisional_credential), { code: 'ONBOARDING_UNAVAILABLE' });
  assert.equal(f.h.installation(), undefined);
});

test('approved credential exchange is one-use: replay never rotates the already-issued credential', t => {
  const f = fixture(t), human = owner(f.h), pending = request(f.h);
  publishProof(f.h, pending.ownership_challenge.challenge);
  f.h.decide(human, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const issued = f.h.exchange(pending.request_id, pending.provisional_credential);
  assert.ok(f.h.identify(issued.access_token));
  assert.throws(() => f.h.exchange(pending.request_id, pending.provisional_credential));
  assert.ok(f.h.identify(issued.access_token), 'A replay must not revoke the first valid credential');
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_credentials WHERE revoked=0').get() as { n: number }).n, 1);
  f.restart();
  assert.throws(() => f.h.exchange(pending.request_id, pending.provisional_credential));
  assert.ok(f.h.identify(issued.access_token));
});

test('two independent processes exchanging the same approval issue exactly one valid credential', async t => {
  const f = fixture(t), human = owner(f.h), pending = request(f.h);
  publishProof(f.h, pending.ownership_challenge.challenge);
  f.h.decide(human, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const child = promisify(execFile);
  const source = `
    import { LegacyStore } from ${JSON.stringify(new URL('../../../packages/demo-garage/index.ts', import.meta.url).href)};
    import { HandoruStore } from ${JSON.stringify(new URL('../src/handoru/store.ts', import.meta.url).href)};
    const now=()=>new Date('2026-10-09T08:00:00Z');
    const legacy=new LegacyStore(process.env.TEST_EXCHANGE_DB,{now});
    const handoru=new HandoruStore(legacy.db,${JSON.stringify(origin)},now);
    const delay=Math.max(0,Number(process.env.TEST_EXCHANGE_START)-Date.now());
    if(delay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delay);
    try{process.stdout.write(JSON.stringify({ok:true,result:handoru.exchange(process.env.TEST_REQUEST_ID,process.env.TEST_PROVISIONAL)}));}
    catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code,status:error.status}));}
    finally{legacy.close();}
  `;
  const env = { ...process.env, TEST_EXCHANGE_DB: f.file, TEST_REQUEST_ID: pending.request_id,
    TEST_PROVISIONAL: pending.provisional_credential, TEST_EXCHANGE_START: String(Date.now() + 700) };
  const results = await Promise.all([0, 1].map(async () => {
    const { stdout } = await child(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env });
    return JSON.parse(stdout) as { ok: boolean; result?: { access_token: string }; status?: number };
  }));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok)?.status, 409);
  const issued = results.find(result => result.ok)?.result;
  assert.ok(issued);
  assert.ok(f.h.identify(issued.access_token));
  assert.equal((f.h.db.prepare('SELECT count(*) AS n FROM handoru_credentials WHERE revoked=0').get() as { n: number }).n, 1);
});

test('revoked or suspended connection cannot exchange provisional approval for fresh authority', t => {
  const f = fixture(t), human = owner(f.h), revoked = request(f.h);
  publishProof(f.h, revoked.ownership_challenge.challenge);
  const approved = f.h.decide(human, revoked.request_id, revoked.user_code, 'approved', AUDIT_SCOPES);
  f.h.revoke(human, approved.business_id!, approved.connection_id!);
  assert.throws(() => f.h.exchange(revoked.request_id, revoked.provisional_credential), { code: 'CONNECTION_REVOKED' });
  const suspended = request(f.h);
  const next = f.h.decide(human, suspended.request_id, suspended.user_code, 'approved', AUDIT_SCOPES);
  f.h.db.prepare("UPDATE handoru_connections SET state='suspended' WHERE id=?").run(next.connection_id!);
  assert.throws(() => f.h.exchange(suspended.request_id, suspended.provisional_credential), { code: 'CONNECTION_REVOKED' });
});

test('credential rotation invalidates old tokens and revocation remains effective after restart', t => {
  const f = fixture(t), human = owner(f.h), pending = request(f.h);
  publishProof(f.h, pending.ownership_challenge.challenge);
  const approved = f.h.decide(human, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const first = f.h.exchange(pending.request_id, pending.provisional_credential).access_token;
  const second = f.h.issue(approved.connection_id!);
  assert.equal(f.h.identify(first), undefined);
  assert.ok(f.h.identify(second));
  assert.ok(f.h.db.prepare('SELECT 1 FROM handoru_credentials WHERE token_hash=?').get(hash(second)));
  assert.ok(!JSON.stringify(f.h.db.prepare('SELECT * FROM handoru_credentials').all()).includes(second));
  f.h.revoke(human, approved.business_id!, approved.connection_id!);
  assert.equal(f.h.identify(second), undefined);
  f.restart();
  assert.equal(f.h.identify(first), undefined);
  assert.equal(f.h.identify(second), undefined);
});

test('relay provisioning is firm-scoped and stable on retries and restart without activating the business', t => {
  const f = fixture(t), human = owner(f.h), pending = request(f.h);
  publishProof(f.h, pending.ownership_challenge.challenge);
  const approved = f.h.decide(human, pending.request_id, pending.user_code, 'approved', AUDIT_SCOPES);
  const token = f.h.exchange(pending.request_id, pending.provisional_credential).access_token;
  const actor = f.h.identify(token)!;
  const first = provisionRelay(f.h, actor, approved.business_id!, 'provision-1', 'https://relay.example') as { id: string; endpoint: string };
  assert.match(first.endpoint, /^https:\/\/relay\.example\/relay\/relay-[^/]+\/a2a$/);
  assert.deepEqual(provisionRelay(f.h, actor, approved.business_id!, 'retry-2', 'https://relay.example'), first);
  assert.equal(f.h.business(approved.business_id!).active_connection_id, null);
  f.restart();
  assert.deepEqual(provisionRelay(f.h, f.h.identify(token)!, approved.business_id!, 'retry-after-restart', 'https://relay.example'), first);
  assert.throws(() => provisionRelay(f.h, f.h.identify(token)!, 'foreign-business', 'key', 'https://relay.example'), { code: 'FORBIDDEN' });
});
