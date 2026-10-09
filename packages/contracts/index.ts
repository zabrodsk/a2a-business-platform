export type ServiceId = 'tyre_change' | 'wheel_swap';
export interface ServiceSpec {
  service_id: ServiceId;
  vehicle_type: 'personal' | 'suv' | 'van';
  wheel_size_inches: number;
  rim_type: 'steel' | 'alu';
  runflat: boolean;
  tpms: boolean;
  wheel_count: 4;
}
export interface PriceLine { label: string; amount_minor: number }
export interface PriceResult {
  pricing_version: string;
  service_spec: ServiceSpec;
  line_items: PriceLine[];
  base_total_minor: number;
  discount_bps: number;
  total_minor: number;
  currency: 'CZK';
}
export type ActorRole = 'owner' | 'staff' | 'human_customer' | 'business_agent' | 'customer_agent' | 'owner_agent' | 'unclaimed_agent';
export interface Actor { id: string; role: ActorRole; customer_id?: string; business_id?: string; connection_id?: string; execution_epoch?: number; scopes?: string[] }
export type PaymentMode = 'deposit' | 'full';
export type PaymentProviderName = 'local_demo' | 'masumi';
export interface PurchaseAuthorization {
  kind: 'human_checkout' | 'agent_mandate' | 'demo_chat';
  actor_id: string;
  customer_id: string;
  quote_id: string;
  quote_version: number;
  payment_mode: PaymentMode;
  max_total_minor: number;
  max_deposit_minor: number;
  network: 'local' | 'Preprod';
  seller_id: string;
  asset: string;
  asset_quantity: string;
  max_network_fee: string;
  mapping_version: string;
  mandate_id?: string;
  rulebook_version?: number;
  approved_at: string;
}
export interface PaymentRequest {
  intent_id: string;
  order_id: string;
  quote_id: string;
  customer_id: string;
  payment_mode: PaymentMode;
  amount_minor: number;
  provider: PaymentProviderName;
  network: 'local' | 'Preprod';
  sku: string;
  asset: string;
  asset_quantity: string;
  max_network_fee: string;
  input_hash: string;
  identifier_from_purchaser: string;
  seller_id: string;
  created_at: string;
  authorization: PurchaseAuthorization;
}
export type PaymentState = 'created' | 'purchase_requested' | 'escrow_funded' | 'result_submitted'
  | 'seller_paid' | 'refund_requested' | 'refunded' | 'failed' | 'reconciliation_required';
export interface PaymentObservation {
  provider: PaymentProviderName;
  network: 'local' | 'Preprod';
  state: PaymentState;
  provider_payment_id?: string;
  seller_payment_id?: string;
  blockchain_identifier?: string;
  transaction_hash?: string;
  asset: string;
  asset_quantity: string;
  seller_id: string;
  input_hash: string;
  observed_at: string;
  raw?: unknown;
}
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  start(request: PaymentRequest): Promise<PaymentObservation>;
  observe(request: PaymentRequest, previous?: PaymentObservation): Promise<PaymentObservation>;
  submitResult(request: PaymentRequest, previous: PaymentObservation, resultHash: string): Promise<PaymentObservation>;
  requestRefund(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation>;
  resumePurchase?(request: PaymentRequest, previous?: PaymentObservation): Promise<PaymentObservation>;
  authorizeRefund?(request: PaymentRequest, previous: PaymentObservation): Promise<PaymentObservation>;
  prepareJob?(request: PaymentRequest): Promise<PaymentJob>;
}
export interface PaymentJob {
  simulation?: boolean;
  provider?: PaymentProviderName;
  id: string;
  blockchainIdentifier: string;
  payByTime: number;
  submitResultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
  agentIdentifier: string;
  sellerVKey: string;
  identifierFromPurchaser: string;
  input_hash: string;
}
export class BusinessError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'BusinessError'; }
}
