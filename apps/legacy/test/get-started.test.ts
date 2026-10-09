import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/config.js';
import { freshFixture } from './handoru-fixture.js';

test('public setup instructions require no owner session and issue no private access or active card', async t => {
  const f = await freshFixture(t);
  const page = await f.publicCall('/handle/get-started');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  const html = await page.text();
  assert.match(html, /data-copy="business"/);
  assert.match(html, /data-copy="customer"/);
  for (const path of ['/handle-get-started.css', '/handle-get-started.js']) assert.equal((await f.publicCall(path)).status, 200);

  const business = await f.publicCall('/handle/agent-card-prompt');
  assert.equal(business.status, 200);
  assert.equal(business.headers.get('cache-control'), 'no-store');
  const template = readFileSync(join(repoRoot, 'prompts/business-agent-card.md'), 'utf8').match(/```text\r?\n([\s\S]*?)\r?\n```/)![1]!;
  assert.equal(await business.text(), template.replaceAll('[HANDLE_URL]', f.base));
  const customer = await f.publicCall('/handle/customer-prompt');
  assert.equal(customer.status, 200);
  assert.match(customer.headers.get('content-type')!, /text\/plain/);
  assert.equal(customer.headers.get('cache-control'), 'no-store');
  const source = readFileSync(join(repoRoot, 'prompts/grokbot-customer-registry.md'), 'utf8');
  assert.equal(await customer.text(), [...source.matchAll(/^> (.+)$/gm)].map(match => match[1]).join('\n\n'));

  assert.equal((await f.publicCall('/api/handle/v1/owner/dashboard')).status, 401);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status, 503);
  for (const table of ['handoru_owners', 'handoru_connections', 'handoru_credentials']) {
    assert.equal((f.store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
  }
});
