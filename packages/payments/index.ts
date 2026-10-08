import { BusinessError, type PaymentProvider } from '../contracts/index.js';
import { integer, object, PAYMENT_SKUS, DEMO_SELLER } from './src/common.js';
import { LocalDemoProvider, type LocalDemoOptions } from './src/local.js';
import { MasumiProvider, MASUMI_VERSION, validateMasumiUrl, type MasumiConfig, type MasumiOptions } from './src/masumi.js';

export { PAYMENT_SKUS, MAPPING_VERSION, DEMO_SELLER, selectPaymentSku } from './src/common.js';
export { LocalDemoProvider, type LocalDemoOptions } from './src/local.js';
export { MasumiProvider, MASUMI_VERSION, type MasumiConfig, type MasumiOptions } from './src/masumi.js';

export const MASUMI_REQUIRED_ENV = ['MASUMI_PAYMENT_SERVICE_URL', 'MASUMI_PAYMENT_API_KEY', 'MASUMI_BUYER_API_KEY',
  'MASUMI_SELLER_VKEY', 'MASUMI_SKUS'] as const;

function checkoutNetworkFee(env: NodeJS.ProcessEnv): string {
  const value = env.MASUMI_CHECKOUT_NETWORK_FEE ?? '2000000';
  try { integer(value, 'checkout network fee'); }
  catch { throw new BusinessError('MASUMI_INVALID_CONFIG', 'Masumi checkout network fee must be an integer string', 503); }
  return value;
}

export function readMasumiConfig(env: NodeJS.ProcessEnv = process.env): MasumiConfig | undefined {
  if (env.MASUMI_NETWORK && env.MASUMI_NETWORK !== 'Preprod') {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Only Cardano Preprod is permitted', 503);
  }
  const deadlineProfile = env.MASUMI_TIMING_PROFILE ?? 'standard';
  if (deadlineProfile !== 'standard' && deadlineProfile !== 'preprod_smoke') {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Unknown Masumi timing profile', 503);
  }
  checkoutNetworkFee(env);
  if (env.MASUMI_BLOCKFROST_PROJECT_ID && !/^preprod[a-zA-Z0-9]+$/.test(env.MASUMI_BLOCKFROST_PROJECT_ID)) {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Settlement verification requires a Blockfrost Preprod project', 503);
  }
  if (env.MASUMI_COLLECTION_ADDRESS && !/^addr_test1[a-z0-9]+$/.test(env.MASUMI_COLLECTION_ADDRESS)) {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Collection address must belong to Cardano Preprod', 503);
  }
  if (!env.MASUMI_PAYMENT_SERVICE_URL || !env.MASUMI_PAYMENT_API_KEY || !env.MASUMI_BUYER_API_KEY
    || !env.MASUMI_SELLER_VKEY || !env.MASUMI_SKUS) return undefined;
  if (!/^(?:[a-f0-9]{56}|[a-f0-9]{64})$/.test(env.MASUMI_SELLER_VKEY)) {
    throw new BusinessError('MASUMI_INVALID_CONFIG', 'Seller verification key must be public hexadecimal key material', 503);
  }
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(env.MASUMI_SKUS)); } catch { throw new BusinessError('MASUMI_INVALID_CONFIG', 'MASUMI_SKUS must contain fixed SKU agent identifiers', 503); }
  const skus: Record<string, string> = {};
  for (const [sku, value] of Object.entries(parsed)) {
    if (!PAYMENT_SKUS.some((entry) => entry.sku === sku) || typeof value !== 'string' || !/^[a-f0-9]{57,250}$/.test(value)) {
      throw new BusinessError('MASUMI_INVALID_CONFIG', 'Invalid fixed SKU registration', 503);
    }
    skus[sku] = value;
  }
  if (Object.keys(skus).length === 0) return undefined;
  const timeoutMs = env.MASUMI_TIMEOUT_MS ? Number(env.MASUMI_TIMEOUT_MS) : 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new BusinessError('MASUMI_INVALID_CONFIG', 'Masumi timeout must be 1–60000 milliseconds', 503);
  let sellerUrl: string; let buyerUrl: string;
  const allowLocalHttp = env.MASUMI_ALLOW_LOCAL_HTTP === 'true';
  try { sellerUrl = validateMasumiUrl(env.MASUMI_PAYMENT_SERVICE_URL, allowLocalHttp);
    buyerUrl = validateMasumiUrl(env.MASUMI_BUYER_SERVICE_URL ?? env.MASUMI_PAYMENT_SERVICE_URL, allowLocalHttp); }
  catch { throw new BusinessError('MASUMI_INVALID_CONFIG', 'Masumi server URLs are invalid', 503); }
  return { sellerUrl, buyerUrl, sellerToken: env.MASUMI_PAYMENT_API_KEY, buyerToken: env.MASUMI_BUYER_API_KEY,
    sellerVkey: env.MASUMI_SELLER_VKEY, skus, timeoutMs, buyerWalletAddress: env.MASUMI_BUYER_WALLET_ADDRESS,
    blockfrostProjectId: env.MASUMI_BLOCKFROST_PROJECT_ID, collectionAddress: env.MASUMI_COLLECTION_ADDRESS,
    dedicatedBuyerWallet: env.MASUMI_DEDICATED_BUYER_WALLET === 'true', allowLocalHttp, deadlineProfile,
    buyerLifecycleIsolated: env.MASUMI_BUYER_LIFECYCLE_ISOLATED === 'true',
    preprodPurchasesEnabled: env.MASUMI_ENABLE_PREPROD_PURCHASES === 'true' };
}

export function paymentProviderStatus(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PAYMENT_PROVIDER ?? 'local_demo';
  if (provider === 'local_demo') return { provider, network: 'local', simulation: true, configured: true, checkout_network_fee: '2000000', seller_id: DEMO_SELLER,
    live_verification: 'NOT_RUN', notice: 'Local simulation; not Masumi on-chain payment', mapping_version: 'demo-map-v1', skus: PAYMENT_SKUS };
  if (provider !== 'masumi') throw new BusinessError('PAYMENT_INVALID_PROVIDER', 'Select local_demo or masumi explicitly', 503);
  try {
    const config = readMasumiConfig(env);
    const missingConfiguration: string[] = MASUMI_REQUIRED_ENV.filter(name => !env[name]?.trim());
    if (!config && missingConfiguration.length === 0) missingConfiguration.push('MASUMI_SKUS');
    const missingPurchaseConfiguration = [
      ...(!config?.dedicatedBuyerWallet ? ['MASUMI_DEDICATED_BUYER_WALLET'] : []),
      ...(!config?.buyerWalletAddress ? ['MASUMI_BUYER_WALLET_ADDRESS'] : []),
      ...(!config?.buyerLifecycleIsolated ? ['MASUMI_BUYER_LIFECYCLE_ISOLATED'] : []),
      ...(!config?.preprodPurchasesEnabled ? ['MASUMI_ENABLE_PREPROD_PURCHASES'] : []),
    ];
    const proofConfigured = Boolean(config?.dedicatedBuyerWallet && config?.buyerWalletAddress && config?.buyerLifecycleIsolated);
    return { provider, network: 'Preprod', simulation: false, configured: Boolean(config),
      seller_id: config?.sellerVkey,
      settlement_verification_configured: Boolean(config?.blockfrostProjectId),
      timing_profile: config?.deadlineProfile ?? env.MASUMI_TIMING_PROFILE ?? 'standard',
      checkout_network_fee: checkoutNetworkFee(env),
      missing_configuration: missingConfiguration, missing_purchase_configuration: missingPurchaseConfiguration,
      purchase_ready: Boolean(config && proofConfigured && config.preprodPurchasesEnabled),
      purchase_configuration_complete: Boolean(config && proofConfigured), api_version: MASUMI_VERSION,
      readiness_definition: 'operator_preprod_test_enabled_not_verified',
      live_verification: 'NOT_RUN', fee_cap: proofConfigured ? 'bounded_wallet_preflight_external_fence_declared_NOT_RUN' : 'not_enforced',
      external_lifecycle_proof: 'GP_NOT_RUN_operator_controls_required',
      reason: !config ? 'MASUMI_NOT_CONFIGURED' : !proofConfigured ? 'MASUMI_FEE_CAP_NOT_ENFORCED'
        : !config.preprodPurchasesEnabled ? 'MASUMI_PREPROD_PURCHASES_DISABLED' : 'LIVE_SMOKE_TEST_REQUIRED',
      notice: 'Cardano Preprod test-ADA; no monetary value. Configuration is not on-chain verification.',
      mapping_version: 'demo-map-v1', skus: PAYMENT_SKUS.map((entry) => ({ ...entry,
        registered: Boolean(config?.skus[entry.sku]), agent_identifier: config?.skus[entry.sku] })) };
  } catch (error) {
    return { provider, network: 'Preprod', simulation: false, configured: false, purchase_ready: false,
      live_verification: 'NOT_RUN', reason: error instanceof BusinessError ? error.code : 'MASUMI_INVALID_CONFIG' };
  }
}

export function createPaymentProvider(env: NodeJS.ProcessEnv = process.env,
  options: MasumiOptions & { local?: LocalDemoOptions } = {}): PaymentProvider {
  const provider = env.PAYMENT_PROVIDER ?? 'local_demo';
  if (provider === 'masumi') return new MasumiProvider(readMasumiConfig(env), options);
  if (provider !== 'local_demo') throw new BusinessError('PAYMENT_INVALID_PROVIDER', 'Select local_demo or masumi explicitly', 503);
  const scenario = env.LOCAL_PAYMENT_SCENARIO ?? 'immediate';
  if (!['immediate', 'delayed', 'failed'].includes(scenario)) throw new BusinessError('PAYMENT_INVALID_CONFIG', 'Unknown local payment fixture', 503);
  return new LocalDemoProvider({ now: options.now, ...options.local,
    scenario: options.local?.scenario ?? (scenario as 'immediate' | 'delayed' | 'failed') });
}
