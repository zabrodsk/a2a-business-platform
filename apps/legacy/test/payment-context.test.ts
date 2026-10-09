import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentContext } from '../public/payment-context.js';

const preprod = { provider: 'masumi', network: 'Preprod', simulation: false };
const local = { provider: 'local_demo', network: 'LocalDemo', simulation: true };

test('new checkout uses current provider configuration without claiming payment completion', () => {
  assert.equal(paymentContext(preprod).simulation, false);
  assert.equal(paymentContext(preprod).onChain, true);
  assert.equal(paymentContext(preprod).recorded, false);
  assert.match(paymentContext(preprod).label, /Masumi.*Preprod/);
  assert.doesNotMatch(paymentContext(preprod).description, /potvrzena|uhrazena|vyplacena/);
  assert.equal(paymentContext(local).simulation, true);
});

test('historical local payments never gain on-chain evidence after switching the runtime to Masumi', () => {
  const context = paymentContext(preprod, local);
  assert.equal(context.provider, 'local_demo');
  assert.equal(context.onChain, false);
  assert.equal(context.simulation, true);
  assert.match(context.label, /Lokální simulace/);
});

test('existing Preprod payments remain Preprod when the runtime later changes to local mode', () => {
  const context = paymentContext(local, preprod);
  assert.equal(context.provider, 'masumi');
  assert.equal(context.network, 'Preprod');
  assert.equal(context.simulation, false);
  assert.equal(context.onChain, true);
});

test('missing, imported or unsupported payment environments do not acquire current runtime evidence', () => {
  for (const payment of [{}, { provider: 'legacy_import' }, { provider: 'masumi' }, { provider: 'masumi', network: 'Mainnet' }]) {
    const context = paymentContext(preprod, payment);
    assert.equal(context.onChain, false);
    assert.equal(context.recorded, true);
  }
  assert.equal(paymentContext(null).onChain, false);
});
