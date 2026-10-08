import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMasumi } from '../src/check.js';

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
