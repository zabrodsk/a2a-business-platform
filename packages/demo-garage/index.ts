import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessError, type ServiceSpec, type PurchaseAuthorization, type PaymentProviderName, type PaymentObservation, type PaymentRequest, type PaymentState } from '../contracts/index.js';
import { calculatePrice, PRICE_CONFIG } from './pricing.js';
import type { Slot, Quote, Order, PaymentIntent, Booking } from './types.js';
export { calculatePrice, validateServiceSpec, PRICE_CONFIG } from './pricing.js';
export type { Slot, Quote, Order, PaymentIntent, Booking } from './types.js';

type Row = Record<string, unknown>;
type Hold = { id:string;order_id:string;slot_id:string;status:string;expires_at:string };
const seedFixture = JSON.parse(readFileSync(new URL('../../fixtures/legacy/seed-v1.json',import.meta.url),'utf8')) as Record<string,Row[]>;
export const BOOKING_CONFIG = JSON.parse(readFileSync(new URL('../../fixtures/booking/booking-v1.json',import.meta.url),'utf8')) as {
  version:string;timezone:string;location_id:string;durations_minutes:Record<string,number>;quote_ttl_seconds:number;
  checkout_hold_seconds:number;deposit_minor:number;main_slot:{start:string;end:string};weekdays:number[];opening_hour:number;closing_hour:number;
};
const fundedStates = new Set<PaymentState>(['escrow_funded','result_submitted','seller_paid']);
const id = (prefix:string) => `${prefix}-${randomUUID()}`;
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code:string,message:string,status=400):never { throw new BusinessError(code,message,status); }
function quantity(value:string):bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('INVALID_ASSET_QUANTITY','Asset quantities and fees must be integer strings in smallest units.');
  return BigInt(value);
}
function parseJson<T>(value:unknown):T { return JSON.parse(String(value)) as T; }

/** Persistent legacy domain. HTTP/agent role checks belong to the calling trusted adapter. */
export class LegacyStore {
  readonly db:Database.Database;
  private readonly clock:()=>Date;
  constructor(filename=':memory:', options:{now?:()=>Date;seed?:boolean}={}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename),{recursive:true});
    this.db = new Database(filename);
    this.clock = options.now ?? (()=>new Date());
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
    if (options.seed !== false) this.seed();
    this.migrateFixtureCustomerProfiles();
  }
  private now():string { return this.clock().toISOString(); }
  private after(seconds:number):string { return new Date(this.clock().getTime()+seconds*1000).toISOString(); }
  private event(type:string,entityId:string,eventType:string,data:unknown={},actorId='legacy-system',effectiveAt=this.now()):void {
    this.db.prepare('INSERT INTO audit_events(entity_type,entity_id,event_type,actor_id,data_json,created_at) VALUES(?,?,?,?,?,?)').run(type,entityId,eventType,actorId,JSON.stringify(data),effectiveAt);
  }
  private insert(table:string,row:Row):void {
    const keys=Object.keys(row);this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));
  }
  private rows<T=Row>(table:string):T[] { return this.db.prepare(`SELECT * FROM ${table}`).all() as T[]; }
  private getSlot(slotId:string):Slot {
    const slot=this.db.prepare('SELECT * FROM calendar_slots WHERE id=?').get(slotId) as Slot|undefined;
    if(!slot) fail('SLOT_NOT_FOUND','Unknown calendar slot.',404);return slot;
  }
  private customer(customerId:string):void { if(!this.db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) fail('CUSTOMER_NOT_FOUND','Unknown synthetic customer.',404); }
  private owner(actorId:string):void { const actor=this.db.prepare('SELECT role FROM staff WHERE id=?').get(actorId) as {role:string}|undefined;if(actor?.role!=='owner') fail('OWNER_REQUIRED','An authenticated owner is required.',403); }
  private staff(actorId:string):void { if(!this.db.prepare('SELECT id FROM staff WHERE id=?').get(actorId)) fail('STAFF_REQUIRED','An authenticated staff actor is required.',403); }

  /** Upgrade only original fixture placeholders; preserve customer edits and all business identities. */
  private migrateFixtureCustomerProfiles():void {
    this.db.transaction(()=>{
      if(!this.db.prepare('SELECT value FROM seed_meta WHERE key=?').get('version')||this.db.prepare('SELECT value FROM seed_meta WHERE key=?').get('customer-profiles-v2'))return;
      const update=this.db.prepare(`UPDATE customers SET
        name=CASE WHEN name=? THEN ? ELSE name END,
        email=CASE WHEN email=? THEN ? ELSE email END,
        phone=CASE WHEN phone=? THEN ? ELSE phone END
        WHERE id=? AND origin='fixture' AND (name=? OR email=? OR phone=?)`);
      let changed=0;
      for(const customer of seedFixture.customers!){
        const suffix=String(customer.id).match(/^customer-(\d{3})$/)?.[1];
        if(!suffix)continue;
        const oldName=`Testovací zákazník ${String(Number(suffix)).padStart(2,'0')}`;
        const oldEmail=`customer${String(Number(suffix)).padStart(2,'0')}@example.com`,oldPhone=`+420 000 000 ${suffix}`;
        changed+=update.run(oldName,customer.name,oldEmail,customer.email,oldPhone,customer.phone,customer.id,oldName,oldEmail,oldPhone).changes;
      }
      this.insert('seed_meta',{key:'customer-profiles-v2',value:this.now()});
      if(changed)this.event('business','pneu007','fixture_customer_profiles_updated',{migration:'customer-profiles-v2',updated_customers:changed});
    }).immediate();
  }

  seed():void {
    this.db.transaction(()=>{
      if(this.db.prepare('SELECT value FROM seed_meta WHERE key=?').get('version')) return;
      for(const table of ['customers','vehicles','staff','resources']) for(const row of seedFixture[table]!) this.insert(table,row);
      this.insert('services',{id:'tyre_change',name:'Přezutí pneumatik',duration_minutes:60});
      this.insert('services',{id:'wheel_swap',name:'Výměna kompletních kol',duration_minutes:45});
      this.insert('price_versions',{id:PRICE_CONFIG.version,configuration_json:JSON.stringify(PRICE_CONFIG)});
      for(const row of seedFixture.suppliers!) this.insert('partners',row);
      for(const row of seedFixture.inventory!) this.insert('inventory',{...row,updated_at:this.now()});
      const start=new Date(this.clock());start.setUTCHours(0,0,0,0);start.setUTCDate(start.getUTCDate()+1);
      const slots:Slot[]=[];
      // Future fixtures use Prague local time (including the CET/CEST boundary).
      let day=start;
      while(slots.length<23){
        if(day.getUTCDay()!==0&&day.getUTCDay()!==6) for(const hour of [9,11,14]) {
          if(slots.length>=23) break;
          const date=day.toISOString().slice(0,10), begin=pragueInstant(date,hour),end=new Date(new Date(begin).getTime()+3600000).toISOString();
          if(begin===BOOKING_CONFIG.main_slot.start) continue;
          slots.push({id:`slot-${String(slots.length+1).padStart(3,'0')}`,resource_id:'resource-box-1',start_at:begin,end_at:end,origin:'fixture'});
        }
        day=new Date(day.getTime()+86400000);
      }
      const mainStart=BOOKING_CONFIG.main_slot.start>this.now()?BOOKING_CONFIG.main_slot.start:pragueInstant(day.toISOString().slice(0,10),16);
      slots.push({id:'slot-main',resource_id:'resource-box-1',start_at:mainStart,end_at:new Date(new Date(mainStart).getTime()+3600000).toISOString(),origin:'fixture'});
      for(const slot of slots) this.insert('calendar_slots',slot as unknown as Row);
      for(let n=1;n<=14;n++) {
        const suffix=String(n).padStart(3,'0'),customerId=`customer-${String((n-1)%12+1).padStart(3,'0')}`;
        let slotId=slots[n-1]!.id;
        // Six paid, three unpaid but manually confirmed legacy bookings. Remaining orders are pending/expired/cancelled.
        const historic=n<=6;
        let createdAt=new Date(this.clock().getTime()-n*86400000).toISOString();
        if(historic) {
          const date=new Date(this.clock().getTime()-(n+1)*86400000);while([0,6].includes(date.getUTCDay()))date.setUTCDate(date.getUTCDate()-1);
          slotId=`slot-history-${suffix}`;const begin=pragueInstant(date.toISOString().slice(0,10),9+n%6);
          this.insert('calendar_slots',{id:slotId,resource_id:'resource-box-1',start_at:begin,end_at:new Date(new Date(begin).getTime()+3600000).toISOString(),origin:'fixture'});
          createdAt=new Date(new Date(begin).getTime()-86400000).toISOString();
        }
        const spec:ServiceSpec={service_id:n%2?'tyre_change':'wheel_swap',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4};
        const price=calculatePrice(spec,n===1?1000:n===2?500:0);
        this.insert('quotes',{id:`quote-fixture-${suffix}`,customer_id:customerId,slot_id:slotId,version:1,price_json:JSON.stringify(price),requires_owner_approval:n===1?1:0,approved_by:n===1?'staff-owner':null,rulebook_version:null,created_at:createdAt,expires_at:new Date(new Date(createdAt).getTime()+600000).toISOString(),origin:'fixture'});
        const status=n<=6?'service_completed':n<=9?'confirmed':n===10?'awaiting_payment':n===11?'owner_approval_required':n===12?'expired':n===13?'cancelled':'draft';
        this.insert('orders',{id:`order-fixture-${suffix}`,quote_id:`quote-fixture-${suffix}`,customer_id:customerId,status,payment_mode:n<=6?'deposit':null,amount_minor:n<=6?50000:null,balance_minor:price.total_minor-(n<=6?50000:0),created_at:createdAt,updated_at:createdAt,origin:'fixture'});
        this.event('quote',`quote-fixture-${suffix}`,'legacy_offered',{price,source_id:'legacy-seed-v1'},'staff-manager',createdAt);
        if(n===1)this.event('quote',`quote-fixture-${suffix}`,'legacy_owner_approved',{discount_bps:1000,reason:'Historical approved customer exception'},'staff-owner',new Date(new Date(createdAt).getTime()+60000).toISOString());
        this.event('order',`order-fixture-${suffix}`,'legacy_import',{status,source_id:'legacy-seed-v1'},'staff-manager',new Date(new Date(createdAt).getTime()+120000).toISOString());
        const fundedAt=new Date(new Date(createdAt).getTime()+180000).toISOString(),confirmedAt=new Date(new Date(createdAt).getTime()+240000).toISOString();
        if(n<=9){this.insert('bookings',{id:`booking-fixture-${suffix}`,order_id:`order-fixture-${suffix}`,slot_id:slotId,customer_id:customerId,status:n<=6?'service_completed':'confirmed',created_at:confirmedAt,updated_at:confirmedAt});this.event('booking',`booking-fixture-${suffix}`,'legacy_confirmed',{order_id:`order-fixture-${suffix}`,manual_legacy_override:n>6},'staff-manager',confirmedAt);}
        if(n<=6){this.insert('payments',{id:`payment-fixture-${suffix}`,order_id:`order-fixture-${suffix}`,intent_id:null,provider:'legacy_import',origin:'fixture',amount_minor:50000,payment_mode:'deposit',state:'legacy_recorded',recorded_at:fundedAt});this.insert('ledger_entries',{id:`ledger-fixture-${suffix}`,payment_id:`payment-fixture-${suffix}`,kind:'legacy_import',amount_minor:50000,currency:'CZK',created_at:fundedAt});this.event('payment',`payment-fixture-${suffix}`,'legacy_import',{provider:'legacy_import',amount_minor:50000},'staff-manager',fundedAt);this.event('order',`order-fixture-${suffix}`,'legacy_service_completed',{slot_id:slotId},'staff-tech',this.getSlot(slotId).end_at);}
      }
      for(let n=1;n<=3;n++){const item=seedFixture.inventory![n-1]!;this.insert('supplier_quotes',{id:`rfq-fixture-${n}`,supplier_id:item.supplier_id,sku:item.sku,quantity:4,unit_price_minor:item.unit_price_minor,status:n===3?'expired':'quoted',requested_by:'staff-manager',created_at:this.now(),expires_at:n===3?this.now():this.after(86400)});}
      this.insert('purchase_orders',{id:'supply-order-fixture-1',supplier_quote_id:'rfq-fixture-1',approved_by:'staff-owner',status:'received',created_at:this.now()});
      this.insert('seed_meta',{key:'version',value:'1'});this.insert('seed_meta',{key:'seeded_at',value:this.now()});
      this.event('business','pneu007','seeded',{source_id:'legacy-seed-v1',active_rulebook:false});
    }).immediate();
  }

  catalog(){ return { services:this.rows('services'),pricing:PRICE_CONFIG,booking:BOOKING_CONFIG,resources:this.rows('resources'),location_id:BOOKING_CONFIG.location_id }; }
  customers(){return this.rows('customers');}
  vehicles(){return this.rows('vehicles');}
  staffMembers(){return this.rows('staff');}
  private expireSafeHolds():void {
    const expired=this.db.prepare("SELECT h.* FROM booking_holds h JOIN payment_intents p ON p.hold_id=h.id WHERE h.status='active' AND h.expires_at<=? AND p.state='created'").all(this.now()) as Hold[];
    for(const hold of expired){this.db.prepare("UPDATE booking_holds SET status='released' WHERE id=?").run(hold.id);this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE id=?").run(this.now(),hold.order_id);this.event('hold',hold.id,'expired_before_purchase');}
  }
  private assertSlotAvailable(slotId:string, excludeOrder?:string, serviceId?:string):Slot {
    const slot=this.getSlot(slotId);
    if(slot.start_at<=this.now()) fail('SLOT_EXPIRED','Cannot book a past slot.',409);
    const minutes=serviceId?BOOKING_CONFIG.durations_minutes[serviceId]:undefined;
    if(minutes&&(new Date(slot.end_at).getTime()-new Date(slot.start_at).getTime())<minutes*60000) fail('SLOT_DURATION','The slot is too short.',409);
    const overlaps="s.resource_id=? AND s.start_at<? AND s.end_at>?";
    const booking=this.db.prepare(`SELECT b.id FROM bookings b JOIN calendar_slots s ON s.id=b.slot_id WHERE ${overlaps} AND b.status IN ('confirmed','service_completed') AND b.order_id<>?`).get(slot.resource_id,slot.end_at,slot.start_at,excludeOrder??'');
    const hold=this.db.prepare(`SELECT h.id FROM booking_holds h JOIN calendar_slots s ON s.id=h.slot_id WHERE ${overlaps} AND h.status IN ('active','reconciliation') AND h.order_id<>?`).get(slot.resource_id,slot.end_at,slot.start_at,excludeOrder??'');
    if(booking||hold) fail('SLOT_CONFLICT','The resource is booked or held during this interval.',409);return slot;
  }
  availability(input:{from?:string;to?:string;service_id?:string}={}) {
    return this.db.transaction(()=>{
      this.expireSafeHolds();
      if(input.service_id&&!Object.hasOwn(BOOKING_CONFIG.durations_minutes,input.service_id))fail('INVALID_SERVICE','Unsupported service.');
      if((input.from&&!Number.isFinite(Date.parse(input.from)))||(input.to&&!Number.isFinite(Date.parse(input.to))))fail('INVALID_DATE_RANGE','Availability requires valid dates.');
      const from=input.from?new Date(input.from).toISOString():this.now(),to=input.to?new Date(input.to).toISOString():'9999-01-01T00:00:00.000Z';
      if(from>=to)fail('INVALID_DATE_RANGE','Availability range must end after it starts.');
      return (this.db.prepare('SELECT * FROM calendar_slots WHERE start_at>=? AND start_at<? ORDER BY start_at').all(from,to) as Slot[]).filter(slot=>{try{this.assertSlotAvailable(slot.id,undefined,input.service_id);return true;}catch(error){if(error instanceof BusinessError&&error.status===409)return false;throw error;}});
    }).immediate();
  }
  createInquiry(input:{customer_id?:string;name:string;email:string;phone:string;service_spec:ServiceSpec;location_id?:string}) {
    if(!input.name?.trim()||!input.email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)||!input.phone?.trim())fail('INVALID_INQUIRY','Name, email and phone are required.');
    if(input.location_id&&input.location_id!==BOOKING_CONFIG.location_id)fail('INVALID_LOCATION','Unknown location.');
    if(input.customer_id)this.customer(input.customer_id);const price=calculatePrice(input.service_spec);
    return this.db.transaction(()=>{const record={id:id('inquiry'),customer_id:input.customer_id??null,name:input.name,email:input.email,phone:input.phone,location_id:BOOKING_CONFIG.location_id,price_json:JSON.stringify(price),created_at:this.now()};this.insert('inquiries',record);this.event('inquiry',record.id,'created',{price});return {...record,price};}).immediate();
  }
  createQuote(input:{customer_id:string;service_spec:ServiceSpec;slot_id:string;discount_bps?:number;rulebook_version?:number;requires_owner_approval?:boolean;offer_ttl_seconds?:number}):Quote {
    const price=calculatePrice(input.service_spec,input.discount_bps??0);this.customer(input.customer_id);
    const ttl=input.offer_ttl_seconds??BOOKING_CONFIG.quote_ttl_seconds;
    if(!Number.isInteger(ttl)||ttl<1||ttl>86400)fail('INVALID_QUOTE_TTL','Offer lifetime must be an integer between 1 and 86400 seconds.');
    return this.db.transaction(()=>{this.expireSafeHolds();this.assertSlotAvailable(input.slot_id,undefined,input.service_spec.service_id);
      const quoteId=id('quote');this.insert('quotes',{id:quoteId,customer_id:input.customer_id,slot_id:input.slot_id,version:1,price_json:JSON.stringify(price),requires_owner_approval:input.requires_owner_approval?1:0,approved_by:null,rulebook_version:input.rulebook_version??null,created_at:this.now(),expires_at:this.after(ttl),origin:'local_operation'});this.event('quote',quoteId,'created',{price,slot_id:input.slot_id});return this.getQuote(quoteId);
    }).immediate();
  }
  getQuote(quoteId:string):Quote {
    const row=this.db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId) as Row|undefined;
    if(!row)fail('QUOTE_NOT_FOUND','Unknown quote.',404);
    const {price_json,requires_owner_approval,...rest}=row;return {...rest,price:parseJson(price_json),requires_owner_approval:!!requires_owner_approval} as Quote;
  }
  approveQuote(quoteId:string,actorId:string):Quote {
    this.owner(actorId);return this.db.transaction(()=>{const quote=this.getQuote(quoteId);if(quote.expires_at<=this.now())fail('QUOTE_EXPIRED','Quote has expired.',409);if(quote.price.discount_bps>1000)fail('DISCOUNT_LIMIT','Owner cannot exceed 10%.',403);this.db.prepare('UPDATE quotes SET approved_by=? WHERE id=?').run(actorId,quoteId);this.event('quote',quoteId,'owner_approved',{discount_bps:quote.price.discount_bps},actorId);return this.getQuote(quoteId);}).immediate();
  }
  createOrder(quoteId:string):Order {
    return this.db.transaction(()=>{const prior=this.db.prepare('SELECT * FROM orders WHERE quote_id=?').get(quoteId) as Order|undefined;if(prior)return prior;
      const quote=this.getQuote(quoteId);if(quote.expires_at<=this.now())fail('QUOTE_EXPIRED','Quote has expired.',409);if(quote.requires_owner_approval&&!quote.approved_by)fail('OWNER_APPROVAL_REQUIRED','The discount requires owner approval.',403);
      this.expireSafeHolds();this.assertSlotAvailable(quote.slot_id,undefined,quote.price.service_spec.service_id);const order:Order={id:id('order'),quote_id:quoteId,customer_id:quote.customer_id,status:'awaiting_payment',payment_mode:null,amount_minor:null,balance_minor:quote.price.total_minor,created_at:this.now(),updated_at:this.now(),origin:'local_operation'};this.insert('orders',order as unknown as Row);this.event('order',order.id,'created',{quote_id:quoteId});return order;
    }).immediate();
  }
  getOrder(orderId:string):Order { const order=this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as Order|undefined;if(!order)fail('ORDER_NOT_FOUND','Unknown order.',404);return order; }
  listOrders(customerId?:string):Order[] {return (customerId?this.db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC').all(customerId):this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all()) as Order[];}

  prepareCheckout(orderId:string,input:{authorization:PurchaseAuthorization;provider:PaymentProviderName;sku:string;asset_quantity:string;max_network_fee:string;seller_id:string;purchaser_identifier?:string;input_hash?:string}):PaymentIntent {
    return this.db.transaction(()=>{
      if(input.purchaser_identifier!==undefined&&(typeof input.purchaser_identifier!=='string'||!/^[a-f0-9]{14,26}$/.test(input.purchaser_identifier)))fail('INVALID_PURCHASER_IDENTIFIER','Purchaser identifier must contain 14–26 lowercase hex characters.');
      if(input.input_hash!==undefined&&(typeof input.input_hash!=='string'||!/^[a-f0-9]{64}$/.test(input.input_hash)))fail('INVALID_INPUT_HASH','Input hash must contain 64 lowercase hex characters.');
      const order=this.getOrder(orderId),quote=this.getQuote(order.quote_id),auth=input.authorization;
      if(!auth||!['human_checkout','agent_mandate'].includes(auth.kind)||!auth.actor_id||!auth.mapping_version||!auth.approved_at||!Number.isFinite(Date.parse(auth.approved_at)))fail('INVALID_AUTHORIZATION','A persisted server authorization is required.',403);
      if(!Number.isSafeInteger(auth.max_total_minor)||auth.max_total_minor<0||!Number.isSafeInteger(auth.max_deposit_minor)||auth.max_deposit_minor<0)fail('INVALID_AUTHORIZATION','Authorization limits must be nonnegative integer minor amounts.',403);
      if(auth.kind==='agent_mandate'&&(!auth.mandate_id||!auth.rulebook_version))fail('INVALID_AUTHORIZATION','Agent authorization requires a mandate and rulebook.',403);
      if(!['deposit','full'].includes(auth.payment_mode))fail('INVALID_PAYMENT_MODE','Choose deposit or full.');
      const amount=auth.payment_mode==='deposit'?BOOKING_CONFIG.deposit_minor:quote.price.total_minor;
      if(auth.customer_id!==order.customer_id||auth.quote_id!==quote.id||auth.quote_version!==quote.version||quote.price.total_minor>auth.max_total_minor||(auth.payment_mode==='deposit'&&amount>auth.max_deposit_minor))fail('MANDATE_LIMIT','Authorization does not match the immutable quote or exceeds customer limits.',403);
      if(!['local_demo','masumi'].includes(input.provider)||auth.network!==(input.provider==='masumi'?'Preprod':'local')||auth.asset!=='lovelace'||auth.seller_id!==input.seller_id||auth.asset_quantity!==input.asset_quantity||auth.max_network_fee!==input.max_network_fee||!input.sku||!input.seller_id)fail('PAYMENT_MAPPING_MISMATCH','Provider, network, seller, asset, amount and fee must match authorization.',403);
      // Synthetic mapping: CZK minor * 100 = lovelace; this is not a market FX rate.
      if(quantity(input.asset_quantity)!==BigInt(amount)*100n||quantity(input.max_network_fee)<0n)fail('PAYMENT_MAPPING_MISMATCH','The requested asset amount differs from the approved CZK mapping.',403);
      const prior=this.db.prepare('SELECT id FROM payment_intents WHERE order_id=?').get(orderId) as {id:string}|undefined;
      if(prior){const intent=this.getPaymentIntent(prior.id);if(intent.payment_mode!==auth.payment_mode||intent.provider!==input.provider||intent.sku!==input.sku||intent.asset_quantity!==input.asset_quantity||intent.max_network_fee!==input.max_network_fee||intent.seller_id!==input.seller_id||intent.authorization.kind!==auth.kind||intent.authorization.actor_id!==auth.actor_id||intent.authorization.mandate_id!==auth.mandate_id||intent.authorization.rulebook_version!==auth.rulebook_version||(input.purchaser_identifier!==undefined&&intent.identifier_from_purchaser!==input.purchaser_identifier)||(input.input_hash!==undefined&&intent.input_hash!==input.input_hash))fail('IMMUTABLE_CHECKOUT','An order has one immutable checkout; a different payment requires a new approved order.',409);return intent;}
      if(order.status!=='awaiting_payment')fail('ORDER_STATE','This order cannot begin checkout.',409);
      if(quote.expires_at<=this.now())fail('QUOTE_EXPIRED','Quote expired before checkout.',409);
      if(quote.requires_owner_approval&&!quote.approved_by)fail('OWNER_APPROVAL_REQUIRED','The quote needs owner approval.',403);
      this.expireSafeHolds();this.assertSlotAvailable(quote.slot_id,orderId,quote.price.service_spec.service_id);
      const holdId=id('hold'),intentId=id('intent'),created_at=this.now();
      this.insert('booking_holds',{id:holdId,order_id:orderId,slot_id:quote.slot_id,status:'active',expires_at:this.after(BOOKING_CONFIG.checkout_hold_seconds),created_at});
      const request:PaymentRequest={intent_id:intentId,order_id:orderId,quote_id:quote.id,customer_id:order.customer_id,payment_mode:auth.payment_mode,amount_minor:amount,provider:input.provider,network:auth.network,sku:input.sku,asset:auth.asset,asset_quantity:input.asset_quantity,max_network_fee:input.max_network_fee,input_hash:input.input_hash??hash({order_id:orderId,quote_id:quote.id,quote_version:quote.version,price:quote.price,slot_id:quote.slot_id,payment_mode:auth.payment_mode,seller_id:input.seller_id,asset:auth.asset,asset_quantity:input.asset_quantity,sku:input.sku,mapping_version:auth.mapping_version}),identifier_from_purchaser:input.purchaser_identifier??createHash('sha256').update(intentId).digest('hex').slice(0,24),seller_id:input.seller_id,created_at,authorization:structuredClone(auth)};
      this.insert('payment_intents',{id:intentId,order_id:orderId,hold_id:holdId,request_json:JSON.stringify(request),state:'created',observation_json:null,created_at,updated_at:created_at,origin:input.provider==='masumi'?'live_preprod':'local_demo'});
      this.db.prepare('UPDATE orders SET payment_mode=?,amount_minor=?,updated_at=? WHERE id=?').run(auth.payment_mode,amount,created_at,orderId);this.event('payment_intent',intentId,'prepared',{order_id:orderId,hold_id:holdId,amount_minor:amount,network:auth.network},auth.actor_id);return this.getPaymentIntent(intentId);
    }).immediate();
  }
  getPaymentIntent(intentId:string):PaymentIntent {
    const row=this.db.prepare('SELECT * FROM payment_intents WHERE id=?').get(intentId) as Row|undefined;if(!row)fail('INTENT_NOT_FOUND','Unknown payment intent.',404);
    return {...parseJson<PaymentRequest>(row.request_json),hold_id:String(row.hold_id),state:row.state as PaymentState,...(row.observation_json?{observation:parseJson<PaymentObservation>(row.observation_json)}:{}),updated_at:String(row.updated_at),origin:row.origin as PaymentIntent['origin']};
  }
  listPaymentIntents():PaymentIntent[] { return (this.db.prepare('SELECT id FROM payment_intents').all() as {id:string}[]).map(row=>this.getPaymentIntent(row.id)); }
  /** Durable fence BEFORE calling start(); an ambiguous/crashed call is reconciled, never blindly reissued. */
  markPurchaseRequested(intentId:string):PaymentIntent {
    return this.db.transaction(()=>{const intent=this.getPaymentIntent(intentId);if(intent.state!=='created')return intent;
      const hold=this.db.prepare('SELECT * FROM booking_holds WHERE id=?').get(intent.hold_id) as Hold;if(hold.status!=='active'||hold.expires_at<=this.now())fail('HOLD_EXPIRED','Cannot initiate an expired hold.',409);
      this.db.prepare("UPDATE payment_intents SET state='purchase_requested',updated_at=? WHERE id=?").run(this.now(),intentId);this.event('payment_intent',intentId,'purchase_dispatch_started',{identifier_from_purchaser:intent.identifier_from_purchaser});return this.getPaymentIntent(intentId);
    }).immediate();
  }
  recordPaymentObservation(intentId:string,observation:PaymentObservation):PaymentIntent {
    let mismatch=false;
    const result=this.db.transaction(()=>{
      const intent=this.getPaymentIntent(intentId),order=this.getOrder(intent.order_id);
      const previous=intent.observation;
      const allowPartial=observation&&['created','purchase_requested','reconciliation_required'].includes(observation.state);
      const invalidIds=observation&&[observation.provider_payment_id,observation.seller_payment_id].some(value=>value!==undefined&&(typeof value!=='string'||!value.trim()));
      const invalid=!observation||invalidIds||observation.provider!==intent.provider||observation.network!==intent.network||observation.asset!==intent.asset||observation.asset_quantity!==intent.asset_quantity||observation.seller_id!==intent.seller_id||observation.input_hash!==intent.input_hash||(!allowPartial&&!observation.provider_payment_id)||!Number.isFinite(Date.parse(observation.observed_at))||(previous?.provider_payment_id&&observation.provider_payment_id&&previous.provider_payment_id!==observation.provider_payment_id)||(previous?.seller_payment_id&&observation.seller_payment_id&&previous.seller_payment_id!==observation.seller_payment_id)||!['created','purchase_requested','escrow_funded','result_submitted','seller_paid','refund_requested','refunded','failed','reconciliation_required'].includes(observation.state)||(intent.provider==='masumi'&&(fundedStates.has(observation.state)||observation.state==='refunded')&&!observation.transaction_hash);
      if(invalid){mismatch=true;this.reconciliation(intent,'Observation identity, amount, network, proof or seller mismatch');return this.getPaymentIntent(intentId);}
      // Sparse timeout/poll metadata must not forget an already established purchase identity.
      observation={...observation,provider_payment_id:observation.provider_payment_id??previous?.provider_payment_id,seller_payment_id:observation.seller_payment_id??previous?.seller_payment_id};
      // Late polling results may regress remote state. Persist evidence but never undo confirmed funding.
      const rank:Partial<Record<PaymentState,number>>={created:0,purchase_requested:1,escrow_funded:2,result_submitted:3,seller_paid:4,refund_requested:5,refunded:6};
      if(previous&&((rank[observation.state]??-1)<(rank[previous.state]??-1))&&(fundedStates.has(previous.state)||previous.state==='refund_requested')&&observation.state!=='reconciliation_required'){this.event('payment_intent',intentId,'stale_observation_ignored',{state:observation.state,observed_at:observation.observed_at});return intent;}
      if((intent.state==='refunded'||previous?.state==='refunded')&&observation.state!=='refunded'){this.event('payment_intent',intentId,'post_refund_observation_ignored',{state:observation.state});return intent;}
      const recordedFunding=this.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intentId);
      if(recordedFunding&&['created','purchase_requested','failed'].includes(observation.state)){this.event('payment_intent',intentId,'stale_unfunded_observation_ignored',{state:observation.state});return intent;}
      this.db.prepare('UPDATE payment_intents SET state=?,observation_json=?,updated_at=? WHERE id=?').run(observation.state,JSON.stringify(observation),this.now(),intentId);
      this.event('payment_intent',intentId,'provider_observed',{state:observation.state,provider_payment_id:observation.provider_payment_id??null,seller_payment_id:observation.seller_payment_id??null,transaction_hash:observation.transaction_hash??null,observed_at:observation.observed_at});
      if(observation.state==='reconciliation_required'){this.reconciliation(intent,'Provider state uncertain');}
      else if(fundedStates.has(observation.state)){
        this.recordFundedPayment(intent,observation.state);
        const booking=this.db.prepare('SELECT * FROM bookings WHERE order_id=?').get(order.id) as Booking|undefined;
        const hold=this.db.prepare('SELECT * FROM booking_holds WHERE id=?').get(intent.hold_id) as Hold;
        if(['cancel_requested','refund_pending','cancelled'].includes(order.status)){this.reconciliation(intent,'Funding arrived for a cancelled order');this.db.prepare("UPDATE orders SET status='refund_pending',updated_at=? WHERE id=?").run(this.now(),order.id);}
        else if(hold.status==='released'&&!booking){this.reconciliation(intent,'Funding arrived after an unsubmitted hold expired or was released');}
        else if(!booking){
          try{this.assertSlotAvailable(this.getQuote(order.quote_id).slot_id,order.id);}
          catch(error){if(error instanceof BusinessError){this.reconciliation(intent,'Funded slot unavailable or already in the past');return this.getPaymentIntent(intentId);}throw error;}
          const quote=this.getQuote(order.quote_id),bookingId=id('booking');
          this.insert('bookings',{id:bookingId,order_id:order.id,slot_id:quote.slot_id,customer_id:order.customer_id,status:'confirmed',created_at:this.now(),updated_at:this.now()});
          this.db.prepare("UPDATE booking_holds SET status='confirmed' WHERE id=?").run(intent.hold_id);
          this.db.prepare("UPDATE orders SET status='confirmed',balance_minor=?,updated_at=? WHERE id=?").run(quote.price.total_minor-intent.amount_minor,this.now(),order.id);
          this.event('booking',bookingId,'payment_confirmed',{order_id:order.id,intent_id:intentId,provider_state:observation.state});
        }
        else if(booking.status==='confirmed')this.db.prepare("UPDATE orders SET status='confirmed',updated_at=? WHERE id=?").run(this.now(),order.id);
      } else if(observation.state==='refunded') {
        this.db.prepare("UPDATE booking_holds SET status='released' WHERE id=?").run(intent.hold_id);
        this.db.prepare("UPDATE bookings SET status='cancelled',updated_at=? WHERE order_id=?").run(this.now(),order.id);
        this.db.prepare("UPDATE orders SET status='refunded',balance_minor=?,updated_at=? WHERE id=?").run(this.getQuote(order.quote_id).price.total_minor,this.now(),order.id);
        const payment=this.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intentId) as {id:string}|undefined;
        if(payment){this.db.prepare("UPDATE payments SET state='refunded' WHERE id=?").run(payment.id);this.db.prepare("INSERT OR IGNORE INTO ledger_entries(id,payment_id,kind,amount_minor,currency,created_at) VALUES(?,?,?,?,?,?)").run(id('ledger'),payment.id,'refund',-intent.amount_minor,'CZK',this.now());}
      } else if(observation.state==='failed') {
        this.db.prepare("UPDATE booking_holds SET status='released' WHERE id=?").run(intent.hold_id);this.db.prepare("UPDATE orders SET status='payment_failed',updated_at=? WHERE id=?").run(this.now(),order.id);
      } else if(observation.state==='refund_requested') {
        this.db.prepare("UPDATE orders SET status='refund_pending',updated_at=? WHERE id=?").run(this.now(),order.id);
      }
      return this.getPaymentIntent(intentId);
    }).immediate();
    if(mismatch)fail('PAYMENT_OBSERVATION_MISMATCH','Payment evidence does not match this immutable intent; reconciliation required.',409);return result;
  }
  private reconciliation(intent:PaymentIntent,reason:string):void {
    this.db.prepare("UPDATE payment_intents SET state='reconciliation_required',updated_at=? WHERE id=?").run(this.now(),intent.intent_id);
    this.db.prepare("UPDATE booking_holds SET status='reconciliation' WHERE id=? AND status<>'confirmed'").run(intent.hold_id);
    this.db.prepare("UPDATE orders SET status=CASE WHEN status IN ('cancel_requested','refund_pending','cancelled','refunded') THEN status ELSE 'reconciliation_required' END,updated_at=? WHERE id=?").run(this.now(),intent.order_id);this.event('payment_intent',intent.intent_id,'reconciliation_required',{reason});
  }
  private recordFundedPayment(intent:PaymentIntent,state:PaymentState):void {
    const existing=this.db.prepare('SELECT id FROM payments WHERE intent_id=?').get(intent.intent_id) as {id:string}|undefined;
    if(existing){this.db.prepare('UPDATE payments SET state=? WHERE id=?').run(state,existing.id);if(state==='seller_paid')this.db.prepare('INSERT OR IGNORE INTO ledger_entries(id,payment_id,kind,amount_minor,currency,created_at) VALUES(?,?,?,?,?,?)').run(id('ledger'),existing.id,'settled',intent.amount_minor,'CZK',this.now());return;}
    const paymentId=id('payment');this.insert('payments',{id:paymentId,order_id:intent.order_id,intent_id:intent.intent_id,provider:intent.provider,origin:intent.origin,amount_minor:intent.amount_minor,payment_mode:intent.payment_mode,state,recorded_at:this.now()});
    this.insert('ledger_entries',{id:id('ledger'),payment_id:paymentId,kind:'escrow_funded',amount_minor:intent.amount_minor,currency:'CZK',created_at:this.now()});
    if(state==='seller_paid')this.insert('ledger_entries',{id:id('ledger'),payment_id:paymentId,kind:'settled',amount_minor:intent.amount_minor,currency:'CZK',created_at:this.now()});
  }

  calendar(customerId?:string):(Booking&Slot)[] {
    return this.db.prepare(`SELECT s.resource_id,s.start_at,s.end_at,s.origin,b.* FROM bookings b JOIN calendar_slots s ON s.id=b.slot_id ${customerId?'WHERE b.customer_id=?':''} ORDER BY s.start_at`).all(...(customerId?[customerId]:[])) as (Booking&Slot)[];
  }
  ics(bookingId:string):string {
    const booking=this.calendar().find(entry=>entry.id===bookingId);if(!booking)fail('BOOKING_NOT_FOUND','Unknown booking.',404);
    const stamp=(date:string)=>date.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Pneu007//Fictional Demo//CS','BEGIN:VEVENT',`UID:${booking.id}@pneu007.example`,`DTSTAMP:${stamp(this.now())}`,`DTSTART:${stamp(booking.start_at)}`,`DTEND:${stamp(booking.end_at)}`,'SUMMARY:Pneu 007 - fiktivni testovaci rezervace',`STATUS:${booking.status==='cancelled'?'CANCELLED':'CONFIRMED'}`,'END:VEVENT','END:VCALENDAR',''].join('\r\n');
  }
  reschedule(bookingId:string,slotId:string,actorId:string):Booking&Slot {
    this.staff(actorId);return this.db.transaction(()=>{this.expireSafeHolds();const booking=this.calendar().find(entry=>entry.id===bookingId);if(!booking)fail('BOOKING_NOT_FOUND','Unknown booking.',404);if(booking.status!=='confirmed')fail('BOOKING_STATE','Only confirmed future bookings can be rescheduled.',409);const quote=this.getQuote(this.getOrder(booking.order_id).quote_id);this.assertSlotAvailable(slotId,booking.order_id,quote.price.service_spec.service_id);
      this.db.prepare('UPDATE bookings SET slot_id=?,updated_at=? WHERE id=?').run(slotId,this.now(),bookingId);this.db.prepare('UPDATE booking_holds SET slot_id=? WHERE order_id=?').run(slotId,booking.order_id);this.event('booking',bookingId,'rescheduled',{old_slot_id:booking.slot_id,new_slot_id:slotId},actorId);return this.calendar().find(entry=>entry.id===bookingId)!;
    }).immediate();
  }
  cancelOrder(orderId:string,actorId:string):Order {
    this.staff(actorId);return this.db.transaction(()=>{const order=this.getOrder(orderId);if(['cancelled','refunded'].includes(order.status))return order;if(order.status==='service_completed')fail('ORDER_STATE','Completed services cannot be cancelled.',409);
      const row=this.db.prepare('SELECT id FROM payment_intents WHERE order_id=?').get(orderId) as {id:string}|undefined;const intent=row?this.getPaymentIntent(row.id):undefined;
      const uncertain=intent&&['purchase_requested','reconciliation_required'].includes(intent.state),funded=intent&&(['escrow_funded','result_submitted','seller_paid','refund_requested'].includes(intent.state));
      const status=uncertain?'cancel_requested':funded?'refund_pending':'cancelled';this.db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status,this.now(),orderId);
      this.db.prepare("UPDATE bookings SET status='cancelled',updated_at=? WHERE order_id=?").run(this.now(),orderId);
      this.db.prepare('UPDATE booking_holds SET status=? WHERE order_id=?').run(uncertain?'reconciliation':'released',orderId);this.event('order',orderId,'cancellation_requested',{status,refund_confirmed:false},actorId);return this.getOrder(orderId);
    }).immediate();
  }
  partners(){return this.rows('partners').map(partner=>({...partner,api_path:`/api/partners/${partner.id}/inventory`}));}
  inventory(supplierId?:string){return supplierId?this.db.prepare('SELECT * FROM inventory WHERE supplier_id=?').all(supplierId) as Row[]:this.rows('inventory');}
  supplierQuotes(supplierId?:string){return supplierId?this.db.prepare('SELECT * FROM supplier_quotes WHERE supplier_id=?').all(supplierId) as Row[]:this.rows('supplier_quotes');}
  draftSupplierQuote(input:{supplier_id:string;sku:string;quantity:number;actor_id:string}) {
    if(!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>1000)fail('INVALID_QUANTITY','Quantity must be 1–1000.');
    const item=this.db.prepare('SELECT * FROM inventory WHERE supplier_id=? AND sku=?').get(input.supplier_id,input.sku) as Row|undefined;if(!item)fail('SKU_NOT_FOUND','Unknown partner SKU.',404);
    return this.db.transaction(()=>{const rfq={id:id('rfq'),supplier_id:input.supplier_id,sku:input.sku,quantity:input.quantity,unit_price_minor:item.unit_price_minor,status:'draft',requested_by:input.actor_id,created_at:this.now(),expires_at:this.after(86400)};this.insert('supplier_quotes',rfq);this.event('supplier_quote',String(rfq.id),'drafted',{supplier_id:input.supplier_id,sku:input.sku,quantity:input.quantity,purchase_authorized:false},input.actor_id);return rfq;}).immediate();
  }
  updateInventory(itemId:string,input:{stock_quantity:number;eta_days:number},actorId:string){this.staff(actorId);if(!Number.isInteger(input.stock_quantity)||input.stock_quantity<0||!Number.isInteger(input.eta_days)||input.eta_days<0)fail('INVALID_INVENTORY','Stock and ETA must be nonnegative integers.');return this.db.transaction(()=>{const result=this.db.prepare('UPDATE inventory SET stock_quantity=?,eta_days=?,updated_at=? WHERE id=?').run(input.stock_quantity,input.eta_days,this.now(),itemId);if(!result.changes)fail('ITEM_NOT_FOUND','Unknown inventory item.',404);this.event('inventory',itemId,'updated',input,actorId);return this.db.prepare('SELECT * FROM inventory WHERE id=?').get(itemId);}).immediate();}
  auditData() {
    const payments=this.rows('payments');
    return { source_id:'legacy-system-snapshot',version:1,generated_at:this.now(),authority:'legacy-sqlite',synthetic:true,
      catalog:this.catalog(),customers:this.customers().map(customer=>({id:customer.id,pseudonym:`Synthetic ${customer.id}`})),vehicles:this.vehicles().map(({plate,...vehicle})=>vehicle),staff:this.staffMembers(),
      slots:this.rows('calendar_slots'),quotes:this.rows('quotes').map(({price_json,...quote})=>({...quote,price:parseJson(price_json)})),orders:this.listOrders(),holds:this.rows('booking_holds'),bookings:this.calendar(),payments,ledger_entries:this.rows('ledger_entries'),
      payment_intents:this.listPaymentIntents().map(({authorization,observation,...intent})=>({...intent,observation:observation?{provider:observation.provider,network:observation.network,state:observation.state,provider_payment_id:observation.provider_payment_id,transaction_hash:observation.transaction_hash,observed_at:observation.observed_at}:null})),
      partners:this.partners(),inventory:this.inventory(),supplier_quotes:this.supplierQuotes(),purchase_orders:this.rows('purchase_orders'),events:this.rows('audit_events'),
      revenue_summary:{fixture_import_minor:payments.filter(p=>p.origin==='fixture').reduce((sum,p)=>sum+Number(p.amount_minor),0),local_demo_minor:payments.filter(p=>p.origin==='local_demo'&&p.state!=='refunded').reduce((sum,p)=>sum+Number(p.amount_minor),0),live_escrow_minor:payments.filter(p=>p.origin==='live_preprod'&&['escrow_funded','result_submitted'].includes(String(p.state))).reduce((sum,p)=>sum+Number(p.amount_minor),0),live_settled_minor:payments.filter(p=>p.origin==='live_preprod'&&p.state==='seller_paid').reduce((sum,p)=>sum+Number(p.amount_minor),0),currency:'CZK',note:'Synthetic business amounts; not on-chain CZK balances. Escrow is not settlement.'}
    };
  }
  validateSeed(){
    const foreignKeys=this.db.pragma('foreign_key_check') as unknown[];
    const counts=Object.fromEntries(['customers','vehicles','staff','resources','services','quotes','orders','bookings','payments','partners','inventory','supplier_quotes'].map(table=>[table,(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n]));
    const main=this.getSlot('slot-main');let mainAvailable=true;try{this.assertSlotAvailable(main.id);}catch{mainAvailable=false;}
    return {ok:foreignKeys.length===0,foreign_key_errors:foreignKeys,counts,future_slots:(this.db.prepare('SELECT COUNT(*) AS n FROM calendar_slots WHERE start_at>?').get(this.now()) as {n:number}).n,main_slot:main,main_available:mainAvailable};
  }
  resetLocal(beforeReset?:()=>void):void {
    this.db.transaction(()=>{
      if(this.db.prepare("SELECT id FROM payment_intents WHERE origin='live_preprod' OR state IN ('purchase_requested','escrow_funded','result_submitted','refund_requested','reconciliation_required') LIMIT 1").get())fail('UNSAFE_RESET','Reset refused: live Preprod or unresolved funding exists. Use a fresh isolated database.',409);
      beforeReset?.();
      for(const table of ['ledger_entries','payments','bookings','payment_intents','booking_holds','orders','quotes','inquiries','purchase_orders','supplier_quotes','inventory','partners','vehicles','customers','staff','services','price_versions','calendar_slots','resources','seed_meta'])this.db.exec(`DELETE FROM ${table}`);
      this.event('business','pneu007','local_reset',{preserved_events:true});this.seed();
    }).immediate();
  }
  close():void {this.db.close();}
}

function pragueInstant(date:string,hour:number):string {
  const tentative=new Date(`${date}T${String(hour).padStart(2,'0')}:00:00.000Z`);
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',hour:'2-digit',hourCycle:'h23'}).formatToParts(tentative);
  const localHour=Number(parts.find(part=>part.type==='hour')!.value),offset=localHour-hour;
  return new Date(tentative.getTime()-offset*3600000).toISOString();
}
