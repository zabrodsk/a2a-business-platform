import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { serializeEnv } from './env-file.mjs';

test('Node env-file parser round-trips registered SKU JSON and private configuration', () => {
  const values = { MASUMI_SKUS: JSON.stringify({ 'deposit-500': 'a'.repeat(120) }),
    ADMIN_KEY: 'fake-test-token', PURCHASE_WALLET_PREPROD_MNEMONIC: 'fake mnemonic words',
    OPTIONAL: '', LABEL: "operator's test", QUOTED: 'both \'single\' and "double" quotes' };
  assert.deepEqual({ ...parseEnv(serializeEnv(values)) }, values);
});

test('invalid environment entries fail before any file is written', () => {
  assert.throws(() => serializeEnv({ 'BAD\nKEY': 'value' }));
  assert.throws(() => serializeEnv({ VALUE: 123 }));
});
