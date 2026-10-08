import { readFileSync } from 'node:fs';
import { BusinessError, type PriceResult, type PriceLine, type ServiceSpec } from '../contracts/index.js';

export const PRICE_CONFIG = JSON.parse(readFileSync(new URL('../../fixtures/pricing/pricing-v1.json', import.meta.url), 'utf8')) as {
  version:string; services:Record<string,number>; vehicle_surcharge:Record<string,number>;
  rim_surcharge:Record<string,number>; tyre_change_diameter:Record<string,number>; runflat:number; tpms:number;
};
export function validateServiceSpec(spec: ServiceSpec): void {
  if (!spec || !['tyre_change','wheel_swap'].includes(spec.service_id)
      || !['personal','suv','van'].includes(spec.vehicle_type) || !['steel','alu'].includes(spec.rim_type)
      || !Number.isInteger(spec.wheel_size_inches) || spec.wheel_size_inches < 13 || spec.wheel_size_inches > 22
      || typeof spec.runflat !== 'boolean' || typeof spec.tpms !== 'boolean' || spec.wheel_count !== 4) {
    throw new BusinessError('INVALID_SERVICE_SPEC', 'Supported service, vehicle, rim, 13–22 inch diameter, booleans and four wheels are required.');
  }
}
export function calculatePrice(spec: ServiceSpec, discountBps = 0): PriceResult {
  validateServiceSpec(spec);
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 1000) throw new BusinessError('DISCOUNT_LIMIT', 'Discount must be 0–1000 basis points.');
  const line_items:PriceLine[] = [{ label: spec.service_id, amount_minor: PRICE_CONFIG.services[spec.service_id]! },
    { label: spec.vehicle_type, amount_minor: PRICE_CONFIG.vehicle_surcharge[spec.vehicle_type]! },
    { label: spec.rim_type, amount_minor: PRICE_CONFIG.rim_surcharge[spec.rim_type]! }];
  if (spec.service_id === 'tyre_change') {
    line_items.push({ label: 'diameter', amount_minor: PRICE_CONFIG.tyre_change_diameter[String(spec.wheel_size_inches)]! });
    if (spec.runflat) line_items.push({ label:'runflat',amount_minor:PRICE_CONFIG.runflat });
    if (spec.tpms) line_items.push({ label:'tpms',amount_minor:PRICE_CONFIG.tpms });
  }
  const base_total_minor = line_items.reduce((sum,line)=>sum+line.amount_minor,0);
  return { pricing_version:PRICE_CONFIG.version,service_spec:{...spec},line_items,base_total_minor,
    discount_bps:discountBps,total_minor:Math.round(base_total_minor*(10000-discountBps)/10000),currency:'CZK' };
}
