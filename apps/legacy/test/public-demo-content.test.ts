import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceRegistry, type Citation, type RulebookProposal } from '../../../packages/audit/index.js';
import { loadProfile } from '../../relay/src/card.js';
import { loadLegacyConfig, repoRoot } from '../src/config.js';
import { createLegacy } from '../src/server.js';
import { renderPublicDemoContent } from '../src/public-demo-content.js';

const template = (name: string) => readFileSync(join(repoRoot, 'apps/legacy/public', name), 'utf8');
const context = { publicUrl: 'https://pneu007.example', networkFee: '2500000', simulation: false };

test('public demo fields are complete and consistent with booking, contact and payment data', () => {
  const profile = loadProfile('pneu007');
  for (const file of ['index.html', 'kalkulator.html', 'kontakt.html', 'podminky.html']) {
    const html = renderPublicDemoContent(file, template(file), context);
    assert.doesNotMatch(html, /\[PLACEHOLDER[^\]]*\]/);
    assert.ok(!html.includes('<span class="ph">'));
  }
  const contact = renderPublicDemoContent('kontakt.html', template('kontakt.html'), context);
  assert.ok(contact.includes(profile.location!.address)); assert.ok(contact.includes(profile.site.phone));
  assert.match(contact, /09:00–18:00/); assert.match(contact, /P1/); assert.match(contact, /fiktivní plánek/);
  const terms = renderPublicDemoContent('podminky.html', template('podminky.html'), context);
  assert.match(terms, /500 Kč → 5 test-ADA/); assert.match(terms, /výchozí maximální rozpočet 2,5 test-ADA/);
  assert.match(terms, /samostatnou testovací platbu v Kč/); assert.match(terms, /vrácení zadává majitel ručně u platebního poskytovatele/);
  const simulated = renderPublicDemoContent('podminky.html', template('podminky.html'), { ...context, simulation: true });
  assert.match(simulated, /5 simulovaných ADA/); assert.match(simulated, /2,5 simulovaných ADA/);
});

test('missing fee configuration is not presented as a known network cost', () => {
  const html = renderPublicDemoContent('podminky.html', template('podminky.html'), { ...context, networkFee: undefined });
  assert.match(html, /maximální rozpočet zobrazíme před potvrzením platby/);
  assert.doesNotMatch(html, /\[PLACEHOLDER/);
});

test('canonical and html URLs render complete content while approved source integrity stays enforced', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pneu-public-demo-'));
  mkdirSync(join(dir, 'apps/legacy/public'), { recursive: true });
  cpSync(join(repoRoot, 'fixtures/internal'), join(dir, 'fixtures/internal'), { recursive: true });
  for (const file of ['index.html', 'kontakt.html', 'podminky.html', 'kalkulator.html']) writeFileSync(join(dir, 'apps/legacy/public', file), template(file));
  const registry = new SourceRegistry(dir);
  const password = 'synthetic-public-content-password-0123456789';
  const cfg = loadLegacyConfig({ NODE_ENV: 'production', LEGACY_DB_PATH: join(dir, 'legacy.sqlite'), LEGACY_PUBLIC_URL: context.publicUrl, LEGACY_PORT: '0', LEGACY_RECONCILIATION_MS: '0', PAYMENT_PROVIDER: 'local_demo', LEGACY_OWNER_PASSWORD: password, LEGACY_STAFF_PASSWORD: password, LEGACY_CUSTOMER_A_PASSWORD: password, LEGACY_CUSTOMER_B_PASSWORD: password, LEGACY_BUSINESS_AGENT_TOKEN: 'synthetic-public-content-business-0123456789', LEGACY_CUSTOMER_AGENT_A_TOKEN: 'synthetic-public-customer-a-0123456789', LEGACY_CUSTOMER_AGENT_B_TOKEN: 'synthetic-public-customer-b-0123456789', LEGACY_RELAY_ADMIN_TOKEN: 'synthetic-public-relay-admin-0123456789' });
  const system = createLegacy(cfg, { registry });
  const server = system.app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await system.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const cite = (id: string): Citation => { const source = registry.get(id); return { source_id: id, version: source.version, hash: source.hash, excerpt: id.startsWith('web-') ? source.content.slice(0, 1000) : source.content }; };
  const params = registry.config(), operationKeys = ['auto_discount_bps', 'owner_approval_limit_bps', 'hard_discount_limit_bps', 'offer_ttl_seconds', 'deposit_minor'];
  const proposal: RulebookProposal = { params, evidence: Object.fromEntries(Object.keys(params).map(key => [key, [cite(key === 'supplier_allowed_actions' ? 'internal-partners' : operationKeys.includes(key) ? 'internal-operations' : 'internal-systems')]])) as RulebookProposal['evidence'], profile: { name: 'Pneu 007 TEST FIXTURE', summary: 'Explicit test-authored backwards compatibility fixture.', systems: ['native-legacy'], partners: ['fictional-supplier'], channels: ['web'], citations: [cite('web-home'), cite('web-contact'), cite('web-terms')] }, findings: [] };
  const proposed = system.rulebooks.propose({ id: 'garage-demo', role: 'business_agent' }, proposal);
  const approved = system.rulebooks.activate({ id: 'staff-owner', role: 'owner' }, proposed.version);
  for (const path of ['/', '/index.html', '/kalkulator', '/kalkulator.html', '/kontakt', '/kontakt.html', '/podminky', '/podminky.html']) {
    const response = await fetch(base + path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/html/);
    const html = await response.text(); assert.doesNotMatch(html, /\[PLACEHOLDER[^\]]*\]/);
    assert.match(html, /<header class="site-header">/);
  }
  assert.deepEqual(system.rulebooks.getActive().source_manifest, approved.source_manifest);
  assert.equal(system.rulebooks.getActive().version, approved.version);
  // A real governing source change must still invalidate the original approval.
  const operations = join(dir, 'fixtures/internal/operations.md'); writeFileSync(operations, readFileSync(operations, 'utf8').replace('auto_discount_bps=500', 'auto_discount_bps=300'));
  assert.throws(() => system.rulebooks.getActive());
});
