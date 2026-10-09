import { BusinessError, type PaymentRequest } from '../../contracts/index.js';

export const PAYMENT_SKUS = [
  { sku: 'deposit-500', payment_mode: 'deposit', amount_minor: 50000, asset_quantity: '5000000' },
  { sku: 'full-main-base', payment_mode: 'full', amount_minor: 247200, asset_quantity: '24720000' },
  { sku: 'full-main-5pct', payment_mode: 'full', amount_minor: 234840, asset_quantity: '23484000' },
  { sku: 'full-main-10pct', payment_mode: 'full', amount_minor: 222480, asset_quantity: '22248000' },
] as const;
export const MAPPING_VERSION = 'demo-map-v1';
export const DEMO_SELLER = 'pneu007-demo';

export function integer(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BusinessError('PAYMENT_INVALID_QUANTITY', `${label} must be an integer string`);
  }
  return BigInt(value);
}

export function validateRequest(request: PaymentRequest, provider: 'local_demo' | 'masumi', seller: string): void {
  const a = request.authorization;
  if (a.kind === 'demo_chat' && (provider !== 'local_demo' || request.network !== 'local')) {
    throw new BusinessError('DEMO_ONLY', 'Chat consent cannot authorize an external payment', 403);
  }
  const sku = PAYMENT_SKUS.find((entry) => entry.sku === request.sku);
  if (!sku || sku.payment_mode !== request.payment_mode || sku.amount_minor !== request.amount_minor
    || sku.asset_quantity !== request.asset_quantity || request.asset !== 'lovelace') {
    throw new BusinessError('PAYMENT_UNSUPPORTED_SKU', 'This amount requires an approved fixed demo SKU');
  }
  const network = provider === 'masumi' ? 'Preprod' : 'local';
  if (request.provider !== provider || request.network !== network || request.seller_id !== seller) {
    throw new BusinessError('PAYMENT_IDENTITY_MISMATCH', 'Provider, network or seller differs from configuration');
  }
  if (a.quote_id !== request.quote_id || a.customer_id !== request.customer_id || a.payment_mode !== request.payment_mode
    || a.network !== network || a.seller_id !== seller || a.asset !== request.asset
    || a.asset_quantity !== request.asset_quantity || a.mapping_version !== MAPPING_VERSION
    || request.amount_minor > a.max_total_minor
    || (request.payment_mode === 'deposit' && request.amount_minor > a.max_deposit_minor)) {
    throw new BusinessError('PAYMENT_AUTHORIZATION_MISMATCH', 'Payment differs from the approved purchase authorization');
  }
  if (integer(request.max_network_fee, 'max_network_fee') > integer(a.max_network_fee, 'authorized max_network_fee')) {
    throw new BusinessError('PAYMENT_FEE_LIMIT', 'Network fee budget exceeds authorization');
  }
  if (!/^[a-f0-9]{64}$/.test(request.input_hash) || !/^(?:[a-f0-9]{2}){7,13}$/.test(request.identifier_from_purchaser)) {
    throw new BusinessError('PAYMENT_INVALID_IDENTIFIER', 'SHA-256 input hash and even-length 14–26 character hex nonce required');
  }
}

export type JsonObject = Record<string, unknown>;
export function object(value: unknown, label = 'response'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BusinessError('MASUMI_INVALID_RESPONSE', `${label} is not an object`, 502);
  }
  return value as JsonObject;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BusinessError('MASUMI_INVALID_RESPONSE', `${label} is missing`, 502);
  }
  return value;
}

export function selectPaymentSku(input: {
  payment_mode: 'deposit' | 'full'; amount_minor: number; max_network_fee: string;
  network?: 'local' | 'Preprod'; seller_id?: string;
}, env: NodeJS.ProcessEnv = process.env) {
  integer(input.max_network_fee, 'max_network_fee');
  const sku = PAYMENT_SKUS.find((entry) => entry.payment_mode === input.payment_mode && entry.amount_minor === input.amount_minor);
  if (!sku) throw new BusinessError('PAYMENT_UNSUPPORTED_SKU', 'No registered fixed SKU for this quote; request owner review');
  const network = input.network ?? (env.PAYMENT_PROVIDER === 'masumi' ? 'Preprod' : 'local');
  const seller_id = input.seller_id ?? (network === 'Preprod' ? env.MASUMI_SELLER_VKEY : DEMO_SELLER);
  if (!seller_id) throw new BusinessError('MASUMI_NOT_CONFIGURED', 'Masumi seller verification key is missing', 503);
  return { ...sku, network, seller_id, asset: 'lovelace', mapping_version: MAPPING_VERSION, max_network_fee: input.max_network_fee };
}
