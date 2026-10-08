// Provision the two local Preprod nodes after their database migration/admin seed.
// Wallet secrets and API tokens remain in mode-0600 environment files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { writePrivateEnv } from './env-file.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const settings = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'));
const rpcKey = settings.BLOCKFROST_API_KEY_PREPROD ?? '';
if (rpcKey && !rpcKey.startsWith('preprod')) throw new Error('Use a Blockfrost Preprod project key.');
const contract = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';
const policy = '7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77';
const admins = [
  'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
  'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
  'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w',
];
const feeWallet = 'addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496';

function saveEnv(path, values) {
  writePrivateEnv(path, values);
}

async function provision(side, port) {
  const path = resolve(directory, `${side}.env`);
  const env = parseEnv(readFileSync(path, 'utf8'));
  if (!env.ADMIN_KEY) throw new Error(`${side}: ADMIN_KEY is missing.`);
  const base = `http://127.0.0.1:${port}/api/v1`;
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { token: env.ADMIN_KEY, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${side}: ${method} ${route} returned HTTP ${response.status}.`);
    const envelope = await response.json();
    if (envelope.status !== 'success' || !envelope.data) throw new Error(`${side}: invalid API response for ${route}.`);
    return envelope.data;
  }

  let sources = (await api('/payment-source-extended/')).ExtendedPaymentSources;
  if (!Array.isArray(sources) || sources.length > 1 || sources.some(source => source.network !== 'Preprod')) {
    throw new Error(`${side}: expected an isolated node with at most one Preprod payment source.`);
  }
  let source = sources[0];
  const firstConnection = Boolean(rpcKey && !source?.PaymentSourceConfig?.rpcProviderApiKey);
  if (!source) {
    // Collection is optional on Preprod. If configured, store its public address only.
    for (const role of ['PURCHASE', 'SELLING']) {
      const prefix = `${role}_WALLET_PREPROD`;
      if (!env[`${prefix}_MNEMONIC`]) {
        const wallet = await api('/wallet/', { network: 'Preprod' });
        if (typeof wallet.walletMnemonic !== 'string' || !wallet.walletAddress?.startsWith('addr_test')) {
          throw new Error(`${side}: generated wallet is invalid.`);
        }
        env[`${prefix}_MNEMONIC`] = wallet.walletMnemonic;
        env[`${prefix}_ADDRESS`] = wallet.walletAddress;
        saveEnv(path, env);
      }
    }
    source = await api('/payment-source-extended/', {
      network: 'Preprod', paymentType: 'Web3CardanoV1',
      PaymentSourceConfig: { rpcProvider: 'Blockfrost', rpcProviderApiKey: rpcKey },
      feeRatePermille: 50, cooldownTime: 420000,
      AdminWallets: admins.map(walletAddress => ({ walletAddress })),
      FeeReceiverNetworkWallet: { walletAddress: feeWallet },
      PurchasingWallets: [{ walletMnemonic: env.PURCHASE_WALLET_PREPROD_MNEMONIC,
        collectionAddress: env.COLLECTION_WALLET_PREPROD_ADDRESS || null, note: `Pneu007 isolated Preprod ${side}` }],
      SellingWallets: [{ walletMnemonic: env.SELLING_WALLET_PREPROD_MNEMONIC,
        collectionAddress: env.COLLECTION_WALLET_PREPROD_ADDRESS || null, note: `Pneu007 Preprod ${side}` }],
    });
  }
  if (source.smartContractAddress !== contract || source.PurchasingWallets?.length !== 1 || source.SellingWallets?.length !== 1) {
    throw new Error(`${side}: unexpected contract or wallet configuration.`);
  }
  if (rpcKey && (firstConnection || source.PaymentSourceConfig?.rpcProviderApiKey !== rpcKey)) {
    const update = { id: source.id, PaymentSourceConfig: { rpcProvider: 'Blockfrost', rpcProviderApiKey: rpcKey } };
    if (firstConnection) {
      // Match upstream seed: start a newly connected, unused source at the latest
      // real contract transaction instead of replaying the shared contract's history.
      const response = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${contract}/transactions?count=1&order=desc`, {
        headers: { project_id: rpcKey }, signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Preprod checkpoint lookup failed.');
      const latest = (await response.json())[0]?.tx_hash;
      if (!/^[a-f0-9]{64}$/.test(latest)) throw new Error('Confirmed Preprod contract checkpoint missing.');
      update.lastIdentifierChecked = latest;
    }
    await api('/payment-source-extended/', update, 'PATCH');
  }
  const confirmed = (await api('/payment-source/')).PaymentSources.find(value => value.id === source.id);
  if (!confirmed || confirmed.policyId !== policy) throw new Error(`${side}: official registry policy was not confirmed.`);
  const permission = side === 'seller' ? 'Read' : 'ReadAndPay';
  if (!env.PNEU007_APP_API_KEY) {
    const keys = (await api('/api-key/')).ApiKeys.filter(key => key.permission === permission
      && key.status === 'Active' && key.networkLimit?.length === 1 && key.networkLimit[0] === 'Preprod');
    if (keys.length > 1) throw new Error(`${side}: multiple application API keys require operator selection.`);
    const key = keys[0] ?? await api('/api-key/', { permission, networkLimit: ['Preprod'],
      usageLimited: side === 'seller' ? 'true' : 'false', UsageCredits: [] });
    env.PNEU007_APP_API_KEY = key.token;
    saveEnv(path, env);
  }
  return { base, token: env.PNEU007_APP_API_KEY, source_id: source.id,
    purchasing_address: source.PurchasingWallets[0].walletAddress,
    selling_address: source.SellingWallets[0].walletAddress,
    seller_vkey: source.SellingWallets[0].walletVkey,
    collection_address: env.COLLECTION_WALLET_PREPROD_ADDRESS,
    application_permission: permission };
}

try {
  const seller = await provision('seller', 3001);
  const buyer = await provision('buyer', 3002);
  const appPath = resolve(root, '.env.legacy.local');
  const app = existsSync(appPath) ? parseEnv(readFileSync(appPath, 'utf8')) : {};
  Object.assign(app, { PAYMENT_PROVIDER: 'masumi', MASUMI_NETWORK: 'Preprod',
    MASUMI_PAYMENT_SERVICE_URL: seller.base, MASUMI_BUYER_SERVICE_URL: buyer.base,
    MASUMI_PAYMENT_API_KEY: seller.token, MASUMI_BUYER_API_KEY: buyer.token,
    MASUMI_SELLER_VKEY: seller.seller_vkey, MASUMI_BUYER_WALLET_ADDRESS: buyer.purchasing_address,
    MASUMI_ALLOW_LOCAL_HTTP: 'true' });
  app.MASUMI_SKUS ??= '{}';
  app.MASUMI_DEDICATED_BUYER_WALLET ??= 'false';
  app.MASUMI_BUYER_LIFECYCLE_ISOLATED ??= 'false';
  app.MASUMI_ENABLE_PREPROD_PURCHASES ??= 'false';
  saveEnv(appPath, app);
  const publicNode = ({ token, ...details }) => details;
  const evidence = { phase: rpcKey ? 'wallets_created_rpc_configured' : 'wallets_created_awaiting_blockfrost',
    network: 'Preprod', on_chain_verification: 'NOT_RUN', seller: publicNode(seller), buyer: publicNode(buyer),
    buyer_api_budget: 'Preprod-only; no API credit cap. Purchases remain disabled pending wallet budget verification.' };
  writeFileSync(resolve(root, 'data/masumi-node-setup.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
} catch {
  console.error('Node provisioning did not complete. Check node health, migration/admin seed and private configuration; secrets were not printed.');
  process.exitCode = 1;
}
