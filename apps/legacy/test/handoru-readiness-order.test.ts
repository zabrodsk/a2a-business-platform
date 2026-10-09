import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFixture, onboard, provision, audited, activate, probe, json, operationScopes } from './handoru-fixture.js';

test('managed setup completes the rulebook probe with audit access before operation consent and webhook registration', async t => {
  const f = await freshFixture(t, { unified: true });
  const manifest = await json(await f.publicCall('/.well-known/handle-managed.json'));
  assert.deepEqual(manifest.operation_setup.order, [
    'owner_rulebook_activation', 'agent_rulebook_probe', 'owner_operation_grant', 'agent_webhook_setup',
  ]);
  assert.equal(manifest.operation_setup.probe.scope, 'relay.provision');
  assert.equal(manifest.operation_setup.probe.operation_grant_required, false);
  assert.equal(manifest.operation_setup.probe.webhook_required, false);

  const c = await onboard(f), relay = await provision(c), audit = await audited(f, c);
  const grantPath = `${c.path}/owner/connections/${c.connectionId}/authorize-operation`;
  const grant = { scopes: operationScopes, expected_epoch: 0 };
  const doorbellPath = `/relay/${relay.id}/bot/doorbell`;
  // Synthetic callback registration only: no external callback or runtime is contacted.
  const callback = { url: 'https://api2.cursor.sh/synthetic-test-hook', key: 'synthetic-webhook-key', test: false };
  assert.equal((await c.agent(doorbellPath, callback)).status, 403);
  assert.equal((await json(await c.owner.call(grantPath, grant), 409)).error.code, 'RULEBOOK_INACTIVE');

  await activate(c, audit);
  assert.equal((await json(await c.owner.call(grantPath, grant), 409)).error.code, 'CAPABILITY_PROBE_REQUIRED');
  assert.equal((await c.agent(doorbellPath, callback)).status, 403);
  const capabilities = await json(await c.agent(`${c.path}/capabilities`));
  assert.deepEqual(capabilities.operation_setup, manifest.operation_setup);
  const before = await json(await c.agent('/api/handle/v1/me'));
  assert.ok(!before.scopes.includes('inbox.claim'));

  const result = await probe(c, audit.proposal.payload_hash);
  assert.equal(result.phase, 'rulebook');
  assert.equal(result.probe_passed, true);
  assert.equal(result.rulebook_hash, audit.proposal.payload_hash);
  assert.deepEqual(await json(await c.agent('/api/handle/v1/me')), before, 'Probe must not grant permissions');
  assert.equal((await c.agent(doorbellPath, callback)).status, 403, 'Webhook still requires independent operation consent');

  await json(await c.owner.call(grantPath, grant));
  const configured = await json(await c.agent(doorbellPath, callback));
  assert.equal(configured.ok, true);
  assert.ok(!JSON.stringify(configured).includes(callback.key));
});
