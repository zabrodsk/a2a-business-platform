import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyStore,calculatePrice, type PaymentIntent } from '../index.js';
import type { PaymentObservation, PurchaseAuthorization, ServiceSpec } from '../../contracts/index.js';

const BASE:ServiceSpec={service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4};
function setup(){let time=new Date('2026-10-08T08:00:00Z');const store=new LegacyStore(':memory:',{now:()=>time});return {store,advance:(ms:number)=>{time=new Date(time.getTime()+ms);}};}
function checkout(store:LegacyStore, options:{slot?:string;discount?:number;provider?:'local_demo'|'masumi';mode?:'full'|'deposit';customer?:string;purchaser_identifier?:string;input_hash?:string}={}){
  const quote=store.createQuote({customer_id:options.customer??'customer-001',service_spec:BASE,slot_id:options.slot??'slot-main',discount_bps:options.discount??0,requires_owner_approval:(options.discount??0)>500});
  if(quote.requires_owner_approval)store.approveQuote(quote.id,'staff-owner');const order=store.createOrder(quote.id),mode=options.mode??'deposit';
  const authorization:PurchaseAuthorization={kind:'human_checkout',actor_id:'human-customer-1',customer_id:order.customer_id,quote_id:quote.id,quote_version:1,payment_mode:mode,max_total_minor:250000,max_deposit_minor:50000,network:options.provider==='masumi'?'Preprod':'local',seller_id:'pneu007-seller',asset:'lovelace',asset_quantity:String((mode==='deposit'?50000:quote.price.total_minor)*100),max_network_fee:'2000000',mapping_version:'demo-czk-ada-v1',approved_at:'2026-10-08T08:00:00Z'};
  const input={authorization,provider:options.provider??'local_demo',sku:mode==='deposit'?'deposit-v1':'full-quote',asset_quantity:authorization.asset_quantity,max_network_fee:authorization.max_network_fee,seller_id:authorization.seller_id,purchaser_identifier:options.purchaser_identifier,input_hash:options.input_hash};
  return {quote,order,intent:store.prepareCheckout(order.id,input),input};
}
function observation(intent:PaymentIntent,state:PaymentObservation['state']='escrow_funded'):PaymentObservation{return {provider:intent.provider,network:intent.network,state,provider_payment_id:`provider-${intent.intent_id}`,asset:intent.asset,asset_quantity:intent.asset_quantity,seller_id:intent.seller_id,input_hash:intent.input_hash,transaction_hash:intent.provider==='masumi'?'preprod-proof-test-only':undefined,observed_at:'2026-10-08T08:05:00Z'};}

test('480 configurations match independent tariff tables; sample sums and rounding are exact',()=>{
  const tyreSteel=[144000,162000,180000,206000,206000,226000,226000,252000,252000,272000];let n=0;
  for(const service_id of ['tyre_change','wheel_swap'] as const)for(const vehicle_type of ['personal','suv','van'] as const)for(let wheel_size_inches=13;wheel_size_inches<=22;wheel_size_inches++)for(const rim_type of ['steel','alu'] as const)for(const runflat of [false,true])for(const tpms of [false,true]){
    const actual=calculatePrice({service_id,vehicle_type,wheel_size_inches,rim_type,runflat,tpms,wheel_count:4});
    let expected=service_id==='wheel_swap'?148000:tyreSteel[wheel_size_inches-13]!;if(vehicle_type!=='personal')expected+=52000;if(rim_type==='alu')expected+=21200;if(service_id==='tyre_change'){if(runflat)expected+=64000;if(tpms)expected+=40000;}
    assert.equal(actual.total_minor,expected);assert.equal(actual.currency,'CZK');n++;
  }
  assert.equal(n,480);assert.equal(calculatePrice(BASE,500).total_minor,234840);assert.equal(calculatePrice(BASE,1000).total_minor,222480);
  assert.equal(calculatePrice({...BASE,runflat:true,tpms:true}).total_minor,351200);
  assert.throws(()=>calculatePrice({...BASE,wheel_size_inches:12}));assert.throws(()=>calculatePrice(BASE,1001));
});
test('seed is linked, complete, explicitly imported, free main slot and no rulebook',()=>{
  const {store}=setup(),result=store.validateSeed();assert.equal(result.ok,true);assert.equal(result.future_slots,24);assert.equal(result.main_available,true);
  assert.deepEqual(result.counts,{customers:12,vehicles:8,staff:3,resources:1,services:2,quotes:14,orders:14,bookings:9,payments:6,partners:2,inventory:10,supplier_quotes:3});
  assert.equal(result.main_slot.start_at,'2026-10-16T14:00:00.000Z');
  for(const payment of store.auditData().payments){assert.equal(payment.origin,'fixture');assert.equal(payment.provider,'legacy_import');assert.equal('transaction_hash' in payment,false);}
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='rulebook_versions'").get(),undefined);
  assert.ok(store.auditData().customers.every(row=>!('email' in row)&&!('phone' in row)));assert.ok(store.auditData().vehicles.every(row=>!('plate' in row)));store.close();
});
test('inquiry creates no order or payment; owner approval caps; expiration prevents checkout',()=>{
  const {store,advance}=setup();const inquiry=store.createInquiry({name:'Dummy',email:'dummy@example.com',phone:'+420 000 000 000',service_spec:BASE});assert.ok(inquiry.id);assert.equal(store.listOrders().length,14);assert.equal(store.listPaymentIntents().length,0);
  const q=store.createQuote({customer_id:'customer-001',service_spec:BASE,slot_id:'slot-main',discount_bps:1000,requires_owner_approval:true});assert.throws(()=>store.createOrder(q.id),{code:'OWNER_APPROVAL_REQUIRED'});assert.throws(()=>store.approveQuote(q.id,'staff-manager'),{code:'OWNER_REQUIRED'});store.approveQuote(q.id,'staff-owner');store.createOrder(q.id);
  advance(600001);assert.throws(()=>store.approveQuote(q.id,'staff-owner'),{code:'QUOTE_EXPIRED'});
  assert.throws(()=>store.createQuote({customer_id:'customer-001',service_spec:BASE,slot_id:'slot-main',discount_bps:1001}),{code:'DISCOUNT_LIMIT'});store.close();
});
test('one intent and booking per order; immutable payment mode; funded vs settled ledger',()=>{
  const {store}=setup();const {order,intent,input,quote}=checkout(store,{discount:1000});assert.equal(store.createOrder(quote.id).id,order.id);assert.equal(store.prepareCheckout(order.id,structuredClone(input)).intent_id,intent.intent_id);
  assert.throws(()=>store.prepareCheckout(order.id,{...input,sku:'different'}),{code:'IMMUTABLE_CHECKOUT'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,authorization:{...input.authorization,payment_mode:'full',asset_quantity:'22248000'},asset_quantity:'22248000'}),{code:'IMMUTABLE_CHECKOUT'});
  store.markPurchaseRequested(intent.intent_id);store.recordPaymentObservation(intent.intent_id,observation(intent));store.recordPaymentObservation(intent.intent_id,observation(intent));
  const booking=store.calendar().find(row=>row.order_id===order.id)!;assert.ok(booking);assert.equal(store.calendar().filter(row=>row.order_id===order.id).length,1);assert.equal(store.getOrder(order.id).balance_minor,172480);
  assert.match(store.ics(booking.id),/DTSTART:20261016T140000Z/);assert.match(store.ics(booking.id),/DTEND:20261016T150000Z/);assert.equal((store.db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(order.id) as {n:number}).n,1);
  store.recordPaymentObservation(intent.intent_id,observation(intent,'seller_paid'));store.recordPaymentObservation(intent.intent_id,observation(intent,'purchase_requested'));assert.equal(store.getPaymentIntent(intent.intent_id).state,'seller_paid');
  const ledger=store.db.prepare('SELECT kind FROM ledger_entries l JOIN payments p ON p.id=l.payment_id WHERE p.order_id=? ORDER BY kind').all(order.id);assert.deepEqual(ledger,[{kind:'escrow_funded'},{kind:'settled'}]);store.close();
});
test('full authorization pays entire business amount; forged financial fields rejected',()=>{
  const {store}=setup();const {order,intent,input}=checkout(store,{discount:1000,mode:'full'});assert.equal(intent.amount_minor,222480);
  assert.throws(()=>store.prepareCheckout(order.id,{...input,authorization:{...input.authorization,max_total_minor:222479}}),{code:'MANDATE_LIMIT'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,max_network_fee:'3000000'}),{code:'PAYMENT_MAPPING_MISMATCH'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,authorization:{...input.authorization,asset:'ADA'}}),{code:'PAYMENT_MAPPING_MISMATCH'});
  store.markPurchaseRequested(intent.intent_id);store.recordPaymentObservation(intent.intent_id,observation(intent));assert.equal(store.getOrder(order.id).balance_minor,0);store.close();
});
test('overlapping interval collision and dispatch fence serialize capacity before provider call',()=>{
  const {store}=setup();const {intent}=checkout(store);store.db.prepare('INSERT INTO calendar_slots(id,resource_id,start_at,end_at,origin) VALUES(?,?,?,?,?)').run('overlap','resource-box-1','2026-10-16T14:30:00.000Z','2026-10-16T15:30:00.000Z','test');
  assert.throws(()=>checkout(store,{customer:'customer-002',slot:'overlap'}),{code:'SLOT_CONFLICT'});assert.equal(store.markPurchaseRequested(intent.intent_id).state,'purchase_requested');assert.equal(store.markPurchaseRequested(intent.intent_id).state,'purchase_requested');store.close();
});
test('unsubmitted hold expires; purchase_requested hold is retained through timeout and late funding',()=>{
  const first=setup(),unsubmitted=checkout(first.store);first.advance(1200001);assert.ok(first.store.availability().some(slot=>slot.id==='slot-main'));assert.throws(()=>first.store.markPurchaseRequested(unsubmitted.intent.intent_id),{code:'HOLD_EXPIRED'});
  first.store.recordPaymentObservation(unsubmitted.intent.intent_id,observation(unsubmitted.intent));assert.equal(first.store.getPaymentIntent(unsubmitted.intent.intent_id).state,'reconciliation_required');assert.equal(first.store.calendar().filter(b=>b.order_id===unsubmitted.order.id).length,0);first.store.close();
  const second=setup(),submitted=checkout(second.store);second.store.markPurchaseRequested(submitted.intent.intent_id);second.advance(1200001);assert.equal(second.store.availability().some(slot=>slot.id==='slot-main'),false);second.store.recordPaymentObservation(submitted.intent.intent_id,observation(submitted.intent));assert.equal(second.store.getOrder(submitted.order.id).status,'confirmed');second.store.close();
});
test('mismatched payment evidence persists reconciliation and no booking, and valid observation recovers',()=>{
  const {store}=setup();const {intent,order}=checkout(store,{provider:'masumi'});store.markPurchaseRequested(intent.intent_id);
  for(const invalid of [{network:'local'},{asset:'BAD'},{asset_quantity:'4999999'},{seller_id:'attacker'},{input_hash:'wrong'},{transaction_hash:undefined}])assert.throws(()=>store.recordPaymentObservation(intent.intent_id,{...observation(intent),...invalid} as PaymentObservation),{code:'PAYMENT_OBSERVATION_MISMATCH'});
  assert.equal(store.getPaymentIntent(intent.intent_id).state,'reconciliation_required');assert.equal(store.calendar().filter(b=>b.order_id===order.id).length,0);assert.equal(store.availability().some(s=>s.id==='slot-main'),false);
  store.recordPaymentObservation(intent.intent_id,observation(intent));assert.equal(store.getOrder(order.id).status,'confirmed');assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});store.close();
});
test('cancel while pending keeps hold, late funding requests refund rather than recreating booking',()=>{
  const {store}=setup();const {intent,order}=checkout(store);store.markPurchaseRequested(intent.intent_id);assert.equal(store.cancelOrder(order.id,'staff-manager').status,'cancel_requested');assert.equal(store.availability().some(s=>s.id==='slot-main'),false);
  store.recordPaymentObservation(intent.intent_id,observation(intent));assert.equal(store.getOrder(order.id).status,'refund_pending');assert.equal(store.calendar().filter(b=>b.order_id===order.id).length,0);store.recordPaymentObservation(intent.intent_id,observation(intent,'refunded'));assert.equal(store.getOrder(order.id).status,'refunded');assert.ok(store.availability().some(s=>s.id==='slot-main'));store.close();
});
test('funded booking reschedules, cancels, refunds without pretending refund is immediate',()=>{
  const {store}=setup();const {intent,order}=checkout(store);store.markPurchaseRequested(intent.intent_id);store.recordPaymentObservation(intent.intent_id,observation(intent));const booking=store.calendar().find(b=>b.order_id===order.id)!;const alternate=store.availability({service_id:'tyre_change'})[0]!;
  store.reschedule(booking.id,alternate.id,'staff-manager');assert.ok(store.availability().some(s=>s.id==='slot-main'));assert.equal(store.calendar().find(b=>b.id===booking.id)!.slot_id,alternate.id);assert.match(store.ics(booking.id),new RegExp(alternate.start_at.replace(/[-:]/g,'').replace(/\.000Z/,'Z')));
  assert.equal(store.cancelOrder(order.id,'staff-manager').status,'refund_pending');assert.equal(store.getPaymentIntent(intent.intent_id).state,'escrow_funded');store.recordPaymentObservation(intent.intent_id,observation(intent,'refund_requested'));store.recordPaymentObservation(intent.intent_id,observation(intent,'refunded'));assert.equal(store.getOrder(order.id).status,'refunded');assert.match(store.ics(booking.id),/STATUS:CANCELLED/);store.close();
});
test('refund and confirmed funding survive delayed failure observations and post-refund mismatch',()=>{
  const {store}=setup();const {intent,order}=checkout(store);store.markPurchaseRequested(intent.intent_id);store.recordPaymentObservation(intent.intent_id,observation(intent));store.cancelOrder(order.id,'staff-manager');store.recordPaymentObservation(intent.intent_id,observation(intent,'refund_requested'));
  store.recordPaymentObservation(intent.intent_id,observation(intent,'failed'));assert.equal(store.getOrder(order.id).status,'refund_pending');assert.equal(store.getPaymentIntent(intent.intent_id).state,'refund_requested');
  store.recordPaymentObservation(intent.intent_id,observation(intent,'refunded'));assert.throws(()=>store.recordPaymentObservation(intent.intent_id,{...observation(intent),asset_quantity:'1'}),{code:'PAYMENT_OBSERVATION_MISMATCH'});
  store.recordPaymentObservation(intent.intent_id,observation(intent));assert.equal(store.getOrder(order.id).status,'refunded');assert.equal(store.auditData().payments.find(payment=>payment.order_id===order.id)!.state,'refunded');
  store.recordPaymentObservation(intent.intent_id,observation(intent,'refunded'));assert.equal(store.getPaymentIntent(intent.intent_id).state,'refunded');assert.ok(store.availability().some(slot=>slot.id==='slot-main'));store.close();
});
test('restart survives unknown funding, duplicate intent and local reset refuses pending state',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pneu007-test-'));try{const path=join(directory,'legacy.db');let store=new LegacyStore(path,{now:()=>new Date('2026-10-08T08:00:00Z')});const {intent,order,input}=checkout(store);store.markPurchaseRequested(intent.intent_id);assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});store.close();
    store=new LegacyStore(path,{now:()=>new Date('2026-10-08T08:35:00Z')});assert.equal(store.getPaymentIntent(intent.intent_id).state,'purchase_requested');assert.equal(store.prepareCheckout(order.id,input).intent_id,intent.intent_id);store.recordPaymentObservation(intent.intent_id,observation(intent));store.close();
    store=new LegacyStore(path,{now:()=>new Date('2026-10-08T08:40:00Z')});store.recordPaymentObservation(intent.intent_id,observation(intent));assert.equal(store.calendar().filter(b=>b.order_id===order.id).length,1);assert.equal(store.getOrder(order.id).status,'confirmed');store.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('Masumi purchaser nonce is persistent lowercase hex and sparse timeouts do not lock a fictitious purchase identity',()=>{
  const {store}=setup(),{intent,order,input}=checkout(store,{provider:'masumi'});
  assert.match(intent.identifier_from_purchaser,/^[a-f0-9]{24}$/);assert.equal(store.prepareCheckout(order.id,input).identifier_from_purchaser,intent.identifier_from_purchaser);
  store.markPurchaseRequested(intent.intent_id);
  const pending={...observation(intent,'purchase_requested'),provider_payment_id:undefined,transaction_hash:undefined,seller_payment_id:'seller-payment-actual'};
  store.recordPaymentObservation(intent.intent_id,pending);assert.equal(store.getPaymentIntent(intent.intent_id).observation?.provider_payment_id,undefined);
  store.recordPaymentObservation(intent.intent_id,{...pending,state:'reconciliation_required'});
  const funded={...observation(intent),provider_payment_id:'actual-buyer-purchase',seller_payment_id:'seller-payment-actual'};store.recordPaymentObservation(intent.intent_id,funded);
  assert.equal(store.getOrder(order.id).status,'confirmed');assert.equal(store.getPaymentIntent(intent.intent_id).observation?.provider_payment_id,'actual-buyer-purchase');
  assert.throws(()=>store.recordPaymentObservation(intent.intent_id,{...funded,provider_payment_id:'different-buyer'}),{code:'PAYMENT_OBSERVATION_MISMATCH'});
  assert.throws(()=>store.recordPaymentObservation(intent.intent_id,{...funded,seller_payment_id:'different-seller-payment'}),{code:'PAYMENT_OBSERVATION_MISMATCH'});
  store.recordPaymentObservation(intent.intent_id,funded);store.recordPaymentObservation(intent.intent_id,{...pending,state:'reconciliation_required'});
  assert.equal(store.getPaymentIntent(intent.intent_id).observation?.provider_payment_id,'actual-buyer-purchase');
  assert.equal(store.getPaymentIntent(intent.intent_id).observation?.seller_payment_id,'seller-payment-actual');store.close();
});
test('funded/refunded states cannot be asserted using only seller metadata or missing buyer identity',()=>{
  const {store}=setup(),{intent}=checkout(store,{provider:'masumi'});store.markPurchaseRequested(intent.intent_id);
  for(const state of ['escrow_funded','seller_paid','refunded'] as const)assert.throws(()=>store.recordPaymentObservation(intent.intent_id,{...observation(intent,state),provider_payment_id:undefined,seller_payment_id:'actual-seller-payment'}),{code:'PAYMENT_OBSERVATION_MISMATCH'});store.close();
});
test('trusted MIP adapter identities are format checked, persisted and immutable on retry',()=>{
  const {store}=setup();const purchaser_identifier='0123456789abcdef01234567',input_hash='a'.repeat(64);
  const {intent,order,input}=checkout(store,{provider:'masumi',purchaser_identifier,input_hash});assert.equal(intent.identifier_from_purchaser,purchaser_identifier);assert.equal(intent.input_hash,input_hash);
  assert.equal(store.prepareCheckout(order.id,{...input}).intent_id,intent.intent_id);
  assert.equal(store.prepareCheckout(order.id,{...input,purchaser_identifier:undefined,input_hash:undefined}).intent_id,intent.intent_id);
  assert.throws(()=>store.prepareCheckout(order.id,{...input,purchaser_identifier:'f'.repeat(24)}),{code:'IMMUTABLE_CHECKOUT'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,input_hash:'b'.repeat(64)}),{code:'IMMUTABLE_CHECKOUT'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,purchaser_identifier:'UPPERCASE-NONCE'}),{code:'INVALID_PURCHASER_IDENTIFIER'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,purchaser_identifier:'a'.repeat(27)}),{code:'INVALID_PURCHASER_IDENTIFIER'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,input_hash:'A'.repeat(64)}),{code:'INVALID_INPUT_HASH'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,input_hash:'a'.repeat(63)}),{code:'INVALID_INPUT_HASH'});
  assert.throws(()=>store.prepareCheckout(order.id,{...input,authorization:{...input.authorization,max_total_minor:1}}),{code:'MANDATE_LIMIT'});store.close();
});
test('supplier changes are reflected in read-only audit; RFQ never creates purchase authority',()=>{
  const {store}=setup();store.updateInventory('item-002',{stock_quantity:7,eta_days:2},'staff-manager');assert.equal(store.inventory('supplier-pneu').find(i=>i.id==='item-002')!.stock_quantity,7);const quote=store.draftSupplierQuote({supplier_id:'supplier-pneu',sku:'DEMO-SKU-002',quantity:4,actor_id:'staff-manager'});assert.equal(quote.status,'draft');assert.equal(store.auditData().purchase_orders.length,1);assert.equal(store.auditData().inventory.find(i=>i.id==='item-002')!.eta_days,2);const events=store.auditData().events.length;store.resetLocal();assert.equal(store.validateSeed().counts.orders,14);assert.ok(store.auditData().events.length>events);store.close();
});
test('layered reset cleans adapter foreign keys inside one transaction and rolls callback failure back',()=>{
  const {store}=setup();store.db.exec('CREATE TABLE adapter_order_links (id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id))');
  store.db.prepare('INSERT INTO adapter_order_links(id,order_id) VALUES(?,?)').run('adapter-1','order-fixture-001');
  const eventsBefore=store.auditData().events.length;
  assert.throws(()=>store.resetLocal(()=>{store.db.exec('DELETE FROM adapter_order_links');throw new Error('adapter cleanup failed');}),/adapter cleanup failed/);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM adapter_order_links').get() as {n:number}).n,1);assert.equal(store.listOrders().length,14);assert.equal(store.auditData().events.length,eventsBefore);
  store.resetLocal(()=>{store.db.exec('DELETE FROM adapter_order_links');});assert.equal((store.db.prepare('SELECT COUNT(*) n FROM adapter_order_links').get() as {n:number}).n,0);assert.equal(store.listOrders().length,14);assert.equal(store.validateSeed().ok,true);store.close();
});
test('layered reset guard runs before adapter cleanup and keeps unresolved purchase data intact',()=>{
  const {store}=setup(),{intent}=checkout(store);store.markPurchaseRequested(intent.intent_id);let callbackInvoked=false;
  assert.throws(()=>store.resetLocal(()=>{callbackInvoked=true;store.db.exec('DELETE FROM audit_events');}),{code:'UNSAFE_RESET'});assert.equal(callbackInvoked,false);assert.equal(store.getPaymentIntent(intent.intent_id).state,'purchase_requested');assert.ok(store.auditData().events.length>0);store.close();
});
test('future runs regenerate coherent Prague slots across DST without stale main slot',()=>{
  const store=new LegacyStore(':memory:',{now:()=>new Date('2026-11-10T08:00:00Z')});const seed=store.validateSeed();assert.equal(seed.future_slots,24);assert.ok(seed.main_slot.start_at>'2026-11-10T08:00:00Z');assert.equal(seed.main_available,true);for(const slot of store.availability()){assert.equal(new Date(slot.end_at).getTime()-new Date(slot.start_at).getTime(),3600000);const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Prague',hour:'numeric',hourCycle:'h23'}).format(new Date(slot.start_at)));assert.ok(hour>=9&&hour<=16);}store.close();
});
