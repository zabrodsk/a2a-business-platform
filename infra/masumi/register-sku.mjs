// Register/reconcile the fixed five-test-ADA deposit service on Cardano Preprod.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivateEnv } from './env-file.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const env = parseEnv(readFileSync(resolve(directory, 'seller.env'), 'utf8'));
const setup = JSON.parse(readFileSync(resolve(root, 'data/masumi-node-setup.json'), 'utf8'));
const name = 'Pneu007 deposit-500';

async function api(path, body) {
  const response = await fetch(setup.seller.base + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { token: env.ADMIN_KEY, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Registry API HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== 'success') throw new Error('Invalid registry response');
  return data.data;
}

try {
  const existing = (await api('/registry/?network=Preprod')).Assets.filter(asset => asset.name === name);
  if (existing.length > 1) throw new Error('Duplicate registration requires reconciliation');
  const asset = existing[0] ?? await api('/registry/', {
    network: 'Preprod', sellingWalletVkey: setup.seller.seller_vkey, name,
    description: 'Fictional Pneu007 reservation deposit. Cardano Preprod test only; no real CZK payment or physical service.',
    apiBaseUrl: 'https://pneu007-production.up.railway.app/masumi',
    Capability: { name: 'pneu007-reservation', version: '1.0' },
    AgentPricing: { pricingType: 'Fixed', Pricing: [{ unit: 'lovelace', amount: '5000000' }] },
    Tags: ['demo', 'reservation', 'preprod'], ExampleOutputs: [], Author: { name: 'Pneu007 demo' },
  });
  const pricing = asset.AgentPricing?.Pricing;
  if (asset.SmartContractWallet?.walletVkey !== setup.seller.seller_vkey
    || pricing?.length !== 1 || !['', 'lovelace'].includes(pricing[0].unit) || pricing[0].amount !== '5000000') {
    throw new Error('Registered price or seller does not match the deposit SKU');
  }
  writeFileSync(resolve(root, 'data/masumi-registration.json'), JSON.stringify({ network: 'Preprod', sku: 'deposit-500', ...asset }, null, 2) + '\n', { mode: 0o600 });
  if (asset.state === 'RegistrationConfirmed' && /^[a-f0-9]{57,250}$/.test(asset.agentIdentifier)) {
    const path = resolve(root, '.env.legacy.local');
    const app = parseEnv(readFileSync(path, 'utf8'));
    const skus = JSON.parse(app.MASUMI_SKUS ?? '{}');
    skus['deposit-500'] = asset.agentIdentifier;
    app.MASUMI_SKUS = JSON.stringify(skus);
    writePrivateEnv(path, app);
  }
  console.log(JSON.stringify({ registration_id: asset.id, state: asset.state,
    agent_identifier: asset.agentIdentifier ?? null, transaction: asset.CurrentTransaction ?? null,
    error: asset.error ? 'Registration reported an error; inspect the private registration record.' : null }));
} catch {
  console.error('Registration response unavailable or validation failed. Reconcile the existing named entry before retrying.');
  process.exitCode = 1;
}
