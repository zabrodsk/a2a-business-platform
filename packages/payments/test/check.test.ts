import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMasumi } from '../src/check.js';
import { createPaymentProvider, paymentProviderStatus, readMasumiConfig } from '../index.js';

const configured = {
  MASUMI_PAYMENT_SERVICE_URL: 'https://seller.example/api/v1',
  MASUMI_BUYER_SERVICE_URL: 'https://buyer.example/api/v1',
  MASUMI_PAYMENT_API_KEY: 'private-seller-token', MASUMI_BUYER_API_KEY: 'private-buyer-token',
  MASUMI_SELLER_VKEY: 'f'.repeat(56), MASUMI_SKUS: JSON.stringify({ 'deposit-500': 'a'.repeat(60) }),
};

test('configuration check lists missing inputs without accepting a local simulation as Masumi', () => {
  const status = checkMasumi({ PAYMENT_PROVIDER: 'local_demo' });
  assert.equal(status.provider, 'masumi');
  assert.equal(status.configured, false);
  assert.equal(status.check, 'configuration_only');
  assert.ok(status.missing_configuration?.includes('MASUMI_PAYMENT_API_KEY'));
  assert.ok(status.missing_configuration?.includes('MASUMI_SKUS'));
  assert.ok(checkMasumi({ ...configured, MASUMI_SKUS: '{}' }).missing_configuration?.includes('MASUMI_SKUS'));
});

test('configuration check separates configuration, purchasing opt-in and live verification', () => {
  const pending = checkMasumi(configured);
  assert.equal(pending.configured, true);
  assert.equal(pending.purchase_ready, false);
  assert.ok(pending.missing_purchase_configuration?.includes('MASUMI_ENABLE_PREPROD_PURCHASES'));
  const enabled = checkMasumi({ ...configured, MASUMI_BUYER_WALLET_ADDRESS: 'addr_test_buyer',
    MASUMI_DEDICATED_BUYER_WALLET: 'true', MASUMI_BUYER_LIFECYCLE_ISOLATED: 'true', MASUMI_ENABLE_PREPROD_PURCHASES: 'true' });
  assert.equal(enabled.purchase_ready, true);
  assert.equal(enabled.live_verification, 'NOT_RUN');
  const output = JSON.stringify(enabled);
  for (const secret of [configured.MASUMI_PAYMENT_API_KEY, configured.MASUMI_BUYER_API_KEY]) assert.ok(!output.includes(secret));
  assert.equal(checkMasumi({ ...configured, MASUMI_NETWORK: 'Mainnet' }).reason, 'MASUMI_INVALID_CONFIG');
});

test('human checkout network fee defaults to 2M and accepts the server-configured Preprod budget without exposing credentials', () => {
  assert.equal(checkMasumi(configured).checkout_network_fee, '2000000');
  const env = { ...configured, MASUMI_CHECKOUT_NETWORK_FEE: '15000000' };
  assert.ok(readMasumiConfig(env));
  const status = checkMasumi(env);
  assert.equal(status.checkout_network_fee, '15000000');
  assert.equal(status.purchase_ready, false);
  for (const secret of [configured.MASUMI_PAYMENT_API_KEY, configured.MASUMI_BUYER_API_KEY]) {
    assert.ok(!JSON.stringify(status).includes(secret));
  }
  assert.equal(paymentProviderStatus({ PAYMENT_PROVIDER: 'local_demo', MASUMI_CHECKOUT_NETWORK_FEE: '15000000' }).checkout_network_fee, '2000000');
});

test('invalid checkout budgets fail closed before creating a Masumi provider and never reflect their value', () => {
  for (const value of ['', '-1', '1.5', '1e6', ' 2000000', '02000000', 'private-invalid-budget']) {
    const env = { ...configured, PAYMENT_PROVIDER: 'masumi', MASUMI_CHECKOUT_NETWORK_FEE: value };
    assert.throws(() => readMasumiConfig(env), { code: 'MASUMI_INVALID_CONFIG' });
    assert.throws(() => createPaymentProvider(env), { code: 'MASUMI_INVALID_CONFIG' });
    assert.throws(() => readMasumiConfig({ MASUMI_CHECKOUT_NETWORK_FEE: value }), { code: 'MASUMI_INVALID_CONFIG' });
    const status = checkMasumi(env);
    assert.equal(status.configured, false);
    assert.equal(status.purchase_ready, false);
    assert.equal(status.reason, 'MASUMI_INVALID_CONFIG');
    assert.equal(status.checkout_network_fee, undefined);
    assert.ok(!JSON.stringify(status).includes('private-invalid-budget'));
  }
});
