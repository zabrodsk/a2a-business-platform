import type { PaymentObservation, PaymentRequest, PaymentState, PriceResult } from '../contracts/index.js';
export interface Slot { id:string; resource_id:string; start_at:string; end_at:string; origin:string }
export interface Quote { id:string; customer_id:string; slot_id:string; version:number; price:PriceResult; requires_owner_approval:boolean; approved_by:string|null; rulebook_version:number|null; created_at:string; expires_at:string; origin:string }
export interface Order { id:string; quote_id:string; customer_id:string; status:string; payment_mode:'deposit'|'full'|null; amount_minor:number|null; balance_minor:number; created_at:string; updated_at:string; origin:string }
export interface PaymentIntent extends PaymentRequest { hold_id:string; state:PaymentState; observation?:PaymentObservation; updated_at:string; origin:'local_demo'|'live_preprod' }
export interface Booking { id:string; order_id:string; slot_id:string; customer_id:string; status:string; created_at:string; updated_at:string }
