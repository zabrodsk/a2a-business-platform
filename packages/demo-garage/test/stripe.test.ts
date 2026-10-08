import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyStore, type StripeCheckout, type StripeSession, type StripePaymentIntentProof } from '../index.js';
import type { ServiceSpec } from '../../contracts/index.js';

const initialTime = Date.parse('2026-10-09T08:00:00.000Z');
const spec:ServiceSpec = { service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4 };
function setup(filename=':memory:') {
  let now=initialTime;
  const clock=()=>new Date(now);
  const store=new LegacyStore(filename,{now:clock});
  return {store,clock,advance:(milliseconds:number)=>{now+=milliseconds;}};
}
function order(store:LegacyStore,slot='slot-main',customer='customer-001') {
  const quote=store.createQuote({customer_id:customer,service_spec:spec,slot_id:slot});
  const order=store.createOrder(quote.id);
  return {order,quote,input:{actor_id:'human-customer-1',customer_id:customer,quote_id:quote.id,quote_version:quote.version,
    payment_mode:'deposit' as 'deposit'|'full',approved_at:new Date(initialTime).toISOString(),stripe_account_id:'acct_testAccount'}};
}
function session(checkout:StripeCheckout,paid=false):StripeSession {
  return {id:'cs_test_sessionOne',livemode:false,mode:'payment',status:paid?'complete':'open',payment_status:paid?'paid':'unpaid',
    amount_total:checkout.amount_minor,currency:'czk',client_reference_id:checkout.id,
    metadata:{checkout_id:checkout.id,order_id:checkout.order_id,quote_id:checkout.quote_id,quote_version:String(checkout.quote_version),
      customer_id:checkout.customer_id,payment_mode:checkout.payment_mode,integration_identifier:checkout.integration_identifier},
    created:initialTime/1000,expires_at:Date.parse(checkout.expires_at)/1000,url:paid?null:'https://checkout.stripe.com/c/pay/cs_test_sessionOne',
    payment_intent:paid?'pi_paymentOne':null,stripe_account_id:checkout.stripe_account_id};
}
function dispatch(store:LegacyStore) {
  const created=order(store);
  const checkout=store.prepareStripeCheckout(created.order.id,created.input);
  store.markStripeCheckoutDispatched(checkout.id);
  return {...created,checkout};
}
function canceledIntent(checkout:StripeCheckout):StripePaymentIntentProof {
  return {id:'pi_paymentOne',object:'payment_intent',livemode:false,status:'canceled',amount:checkout.amount_minor,currency:'czk',
    stripe_account_id:checkout.stripe_account_id,metadata:session(checkout).metadata,amount_received:0};
}
function failedIntent(checkout:StripeCheckout):StripePaymentIntentProof {
  return {...canceledIntent(checkout),status:'requires_payment_method',last_payment_error:{type:'card_error',code:'card_declined'},
    failure_event:{id:'evt_asyncFailed',type:'checkout.session.async_payment_failed',session_id:'cs_test_sessionOne'}};
}
function processingSession(checkout:StripeCheckout):StripeSession {
  return {...session(checkout),status:'complete',url:null,payment_intent:'pi_paymentOne'};
}
function counts(store:LegacyStore,orderId:string) {
  const count=(sql:string)=>Number((store.db.prepare(sql).get(orderId) as {n:number}).n);
  return {payments:count('SELECT COUNT(*) n FROM payments WHERE order_id=?'),
    bookings:count('SELECT COUNT(*) n FROM bookings WHERE order_id=?'),
    ledger:count("SELECT COUNT(*) n FROM ledger_entries l JOIN payments p ON p.id=l.payment_id WHERE p.order_id=? AND l.kind='stripe_paid'")};
}
function legacyCheckout(store:LegacyStore,orderId:string,quoteId:string,customerId='customer-001') {
  const quote=store.getQuote(quoteId);
  return store.prepareCheckout(orderId,{provider:'local_demo',sku:'deposit-500',asset_quantity:'5000000',max_network_fee:'2000000',seller_id:'pneu007-demo',
    authorization:{kind:'human_checkout',actor_id:'human-customer-1',customer_id:customerId,quote_id:quote.id,quote_version:quote.version,
      payment_mode:'deposit',max_total_minor:quote.price.total_minor,max_deposit_minor:50000,network:'local',seller_id:'pneu007-demo',asset:'lovelace',
      asset_quantity:'5000000',max_network_fee:'2000000',mapping_version:'demo-map-v1',approved_at:new Date(initialTime).toISOString()}});
}

test('native CZK checkout persists human identity, stable keys, exact quote and a 31-minute hold',t=>{
  const {store}=setup();t.after(()=>store.close());const created=order(store);
  const checkout=store.prepareStripeCheckout(created.order.id,created.input);
  assert.equal(checkout.state,'prepared');assert.equal(checkout.currency,'czk');assert.equal(checkout.amount_minor,50000);
  assert.equal(checkout.actor_id,'human-customer-1');assert.equal(checkout.session_id,null);assert.equal(checkout.dispatched_at,null);
  assert.match(checkout.integration_identifier,/^pneu007-[a-z]{8}$/);
  assert.equal(Date.parse(checkout.expires_at)-initialTime,31*60000);
  assert.equal(store.prepareStripeCheckout(created.order.id,created.input).id,checkout.id);
  assert.deepEqual(store.getStripeCheckoutForOrder(created.order.id),checkout);
  assert.equal(store.listStripeCheckouts().length,1);assert.equal(store.listPaymentIntents().length,0);
  for(const changed of [{actor_id:'another-human'},{payment_mode:'full' as const},{stripe_account_id:'acct_otherAccount'}]){
    assert.throws(()=>store.prepareStripeCheckout(created.order.id,{...created.input,...changed}),{code:'IMMUTABLE_CHECKOUT'});
  }
  for(const changed of [{customer_id:'customer-002'},{quote_id:'wrong-quote'},{quote_version:2}]){
    assert.throws(()=>store.prepareStripeCheckout(created.order.id,{...created.input,...changed}),{code:'STRIPE_AUTHORIZATION_MISMATCH'});
  }
  assert.throws(()=>store.prepareStripeCheckout(created.order.id,{...created.input,actor_id:''}),{code:'INVALID_AUTHORIZATION'});
  assert.throws(()=>store.prepareStripeCheckout(created.order.id,{...created.input,approved_at:'2027-01-01T00:00:00Z'}),{code:'INVALID_AUTHORIZATION'});
});

test('paid provider evidence atomically creates one CZK payment, ledger and booking; retries survive restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pneu-stripe-'));
  try{
    const filename=join(directory,'legacy.db');const fixture=setup(filename);let store=fixture.store;
    const {order:original,checkout,input}=dispatch(store);
    const firstDispatch=store.getStripeCheckout(checkout.id).dispatched_at;
    fixture.advance(1000);assert.equal(store.markStripeCheckoutDispatched(checkout.id).dispatched_at,firstDispatch);
    assert.equal(store.recordStripeSession(checkout.id,session(checkout)).state,'open');
    assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
    store.close();store=new LegacyStore(filename,{now:fixture.clock});
    assert.equal(store.prepareStripeCheckout(original.id,input).idempotency_key,checkout.idempotency_key);
    assert.equal(store.recordStripePayment(checkout.id,session(checkout,true)).state,'paid');
    store.recordStripePayment(checkout.id,session(checkout,true));store.recordStripeSession(checkout.id,{...session(checkout),payment_intent:'pi_paymentOne'});
    assert.deepEqual(counts(store,original.id),{payments:1,bookings:1,ledger:1});
    assert.equal(store.getOrder(original.id).status,'confirmed');assert.equal(store.getOrder(original.id).balance_minor,197200);
    const payment=store.db.prepare('SELECT * FROM payments WHERE order_id=?').get(original.id) as Record<string,unknown>;
    assert.equal(payment.intent_id,null);assert.equal(payment.provider,'stripe');assert.equal(payment.origin,'stripe_test');assert.equal(payment.state,'paid');
    assert.equal(payment.amount_minor,50000);assert.equal(store.listPaymentIntents().length,0);
    assert.deepEqual(store.db.prepare('SELECT currency FROM ledger_entries WHERE payment_id=?').get(payment.id),{currency:'CZK'});
    store.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('full checkout uses the exact quote total and leaves no business balance',t=>{
  const {store}=setup();t.after(()=>store.close());const created=order(store);
  const checkout=store.prepareStripeCheckout(created.order.id,{...created.input,payment_mode:'full'});
  assert.equal(checkout.amount_minor,247200);store.markStripeCheckoutDispatched(checkout.id);
  store.recordStripePayment(checkout.id,session(checkout,true));assert.equal(store.getOrder(created.order.id).balance_minor,0);
});

for(const tamper of ['amount','currency','live','account','client-reference','metadata','quote-version','payment-intent','session-id','expires','created','quote-price','url'] as const){
  test(`tampered ${tamper} provider evidence commits reconciliation without booking or synthetic payment`,t=>{
    const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
    const paid=session(checkout,true);
    if(tamper==='amount')paid.amount_total++;
    if(tamper==='currency')paid.currency='eur';
    if(tamper==='live')paid.livemode=true;
    if(tamper==='account')paid.stripe_account_id='acct_otherAccount';
    if(tamper==='client-reference')paid.client_reference_id='another-checkout';
    if(tamper==='metadata')paid.metadata.customer_id='customer-002';
    if(tamper==='quote-version')paid.metadata.quote_version='2';
    if(tamper==='payment-intent')paid.payment_intent=null;
    if(tamper==='session-id')paid.id='cs_live_invalidSession';
    if(tamper==='expires')paid.expires_at++;
    if(tamper==='created')paid.created-=100;
    if(tamper==='quote-price'){
      const quote=store.getQuote(checkout.quote_id);quote.price.total_minor++;
      store.db.prepare('UPDATE quotes SET price_json=? WHERE id=?').run(JSON.stringify(quote.price),quote.id);
    }
    if(tamper==='url'){
      const open=session(checkout);open.url='https://attacker.example/c/pay/session';
      assert.throws(()=>store.recordStripeSession(checkout.id,open),{code:'STRIPE_SESSION_MISMATCH'});
    }else assert.throws(()=>store.recordStripePayment(checkout.id,paid),{code:'STRIPE_SESSION_MISMATCH'});
    assert.equal(store.getStripeCheckout(checkout.id).state,'reconciliation_required');
    assert.equal(store.getOrder(original.id).status,'reconciliation_required');
    assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
    assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
  });
}

test('session and PaymentIntent identities cannot change or be reused for a different order',t=>{
  const {store}=setup();t.after(()=>store.close());const first=dispatch(store);
  store.recordStripeSession(first.checkout.id,session(first.checkout));
  assert.throws(()=>store.recordStripePayment(first.checkout.id,{...session(first.checkout,true),id:'cs_test_replacement'}),{code:'STRIPE_SESSION_MISMATCH'});
  store.recordStripePayment(first.checkout.id,session(first.checkout,true));
  const available=store.availability()[0]!;const created=order(store,available.id,'customer-002');
  const second=store.prepareStripeCheckout(created.order.id,created.input);store.markStripeCheckoutDispatched(second.id);
  assert.throws(()=>store.recordStripePayment(second.id,session(second,true)),{code:'STRIPE_SESSION_MISMATCH'});
  assert.throws(()=>store.recordStripePayment(second.id,{...session(second,true),id:'cs_test_otherSession'}),{code:'STRIPE_SESSION_MISMATCH'});
  assert.deepEqual(counts(store,created.order.id),{payments:0,bookings:0,ledger:0});
  assert.deepEqual(counts(store,first.order.id),{payments:1,bookings:1,ledger:1});
});

test('provider-owned holds persist beyond local time and browser cancellation; only verified expiry releases them',t=>{
  const {store,advance}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  store.recordStripeSession(checkout.id,session(checkout));advance(32*60000);
  assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
  assert.throws(()=>store.cancelOrder(original.id,'staff-manager'),{code:'STRIPE_CANCELLATION_UNSUPPORTED'});
  let callback=false;assert.throws(()=>store.resetLocal(()=>{callback=true;}),{code:'UNSAFE_RESET'});assert.equal(callback,false);
  assert.throws(()=>store.expireStripeCheckout(checkout.id,session(checkout)),{code:'STRIPE_SESSION_MISMATCH'});
  const expired={...session(checkout),status:'expired' as const,url:null};
  assert.equal(store.expireStripeCheckout(checkout.id,expired).state,'expired');
  assert.equal(store.expireStripeCheckout(checkout.id,expired).state,'expired');
  assert.equal(store.availability().some(slot=>slot.id==='slot-main'),true);
  assert.equal(store.cancelOrder(original.id,'staff-manager').status,'cancelled');
  store.resetLocal();assert.equal(store.listStripeCheckouts().length,0);
});

test('asynchronous complete/unpaid processing retains the hold and late provider payment can safely book',t=>{
  const {store,advance}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  const processing={...session(checkout),status:'complete' as const,url:null,payment_intent:'pi_paymentOne'};
  assert.equal(store.recordStripeSession(checkout.id,processing).state,'processing');advance(40*60000);
  assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
  assert.equal(store.recordStripeSession(checkout.id,{...session(checkout),payment_intent:'pi_paymentOne'}).state,'processing');
  store.recordStripePayment(checkout.id,session(checkout,true));assert.equal(store.getOrder(original.id).status,'confirmed');
});

test('late paid sessions preserve actual funds and reconciliation without booking a past slot',t=>{
  const {store,advance}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  advance(Date.parse(store.catalog().booking.main_slot.start)-initialTime+1000);
  assert.equal(store.recordStripePayment(checkout.id,session(checkout,true)).state,'reconciliation_required');
  store.recordStripePayment(checkout.id,session(checkout,true));assert.deepEqual(counts(store,original.id),{payments:1,bookings:0,ledger:1});
  assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});
});

test('paid slot conflicts commit real CZK funds once without duplicating another reservation',t=>{
  const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  const quoteId='quote-fixture-010';const otherOrder=store.getOrder('order-fixture-010');
  store.db.prepare('INSERT INTO bookings(id,order_id,slot_id,customer_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('conflicting-booking',otherOrder.id,'slot-main',otherOrder.customer_id,'confirmed',new Date(initialTime).toISOString(),new Date(initialTime).toISOString());
  assert.ok(store.getQuote(quoteId));
  assert.equal(store.recordStripePayment(checkout.id,session(checkout,true)).state,'reconciliation_required');
  assert.deepEqual(counts(store,original.id),{payments:1,bookings:0,ledger:1});
});

test('cross-provider exclusion works both ways and remains immutable after provider expiry',t=>{
  const first=setup();t.after(()=>first.store.close());const stripe=dispatch(first.store);
  assert.throws(()=>legacyCheckout(first.store,stripe.order.id,stripe.quote.id),{code:'CHECKOUT_PROVIDER_CONFLICT'});
  first.store.expireStripeCheckout(stripe.checkout.id,{...session(stripe.checkout),status:'expired',url:null});
  assert.throws(()=>legacyCheckout(first.store,stripe.order.id,stripe.quote.id),{code:'CHECKOUT_PROVIDER_CONFLICT'});
  const second=setup();t.after(()=>second.store.close());const created=order(second.store);
  legacyCheckout(second.store,created.order.id,created.quote.id);
  assert.throws(()=>second.store.prepareStripeCheckout(created.order.id,created.input),{code:'CHECKOUT_PROVIDER_CONFLICT'});
});

test('paid Stripe checkout cannot be cancelled, reset or released by a stale expiry',t=>{
  const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  store.recordStripePayment(checkout.id,session(checkout,true));
  assert.equal(store.expireStripeCheckout(checkout.id,{...session(checkout),status:'expired',url:null,payment_intent:'pi_paymentOne'}).state,'paid');
  assert.throws(()=>store.cancelOrder(original.id,'staff-manager'),{code:'STRIPE_CANCELLATION_UNSUPPORTED'});
  assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});assert.deepEqual(counts(store,original.id),{payments:1,bookings:1,ledger:1});
});

test('a never-dispatched prepared checkout safely expires across restart without creating a replacement',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pneu-stripe-prepared-'));
  try{
    const filename=join(directory,'legacy.db'),fixture=setup(filename);
    const created=order(fixture.store),checkout=fixture.store.prepareStripeCheckout(created.order.id,created.input);
    fixture.store.close();fixture.advance(32*60000);
    const store=new LegacyStore(filename,{now:fixture.clock});
    try{
      assert.equal(store.getStripeCheckout(checkout.id).state,'expired');
      assert.equal(store.prepareStripeCheckout(created.order.id,created.input).id,checkout.id);
      assert.equal(store.prepareStripeCheckout(created.order.id,created.input).state,'expired');
      assert.throws(()=>store.markStripeCheckoutDispatched(checkout.id),{code:'HOLD_EXPIRED'});
      assert.equal(store.listStripeCheckouts().length,1);assert.equal(store.availability().some(slot=>slot.id==='slot-main'),true);
      assert.deepEqual(counts(store,created.order.id),{payments:0,bookings:0,ledger:0});
      assert.equal(store.cancelOrder(created.order.id,'staff-manager').status,'cancelled');store.resetLocal();
    }finally{store.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('crash after dispatch and uncertain creation retain the hold beyond local deadlines',t=>{
  const {store,advance}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  advance(32*60000);assert.equal(store.getStripeCheckout(checkout.id).state,'creating');
  store.markStripeCheckoutReconciliation(checkout.id,'Creation response unavailable');
  assert.equal(store.getStripeCheckout(checkout.id).state,'reconciliation_required');
  assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
  assert.throws(()=>store.cancelOrder(original.id,'staff-manager'),{code:'STRIPE_CANCELLATION_UNSUPPORTED'});
  assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});
});

test('verified canceled asynchronous PaymentIntent releases exactly once without payment, booking or ledger',t=>{
  const {store,advance}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  const processing=processingSession(checkout);store.recordStripeSession(checkout.id,processing);advance(40*60000);
  assert.equal(store.failStripeCheckout(checkout.id,processing,canceledIntent(checkout)).state,'failed');
  assert.equal(store.failStripeCheckout(checkout.id,processing,canceledIntent(checkout)).state,'failed');
  assert.equal(store.recordStripeSession(checkout.id,processing).state,'failed');
  assert.equal(store.getOrder(original.id).status,'payment_failed');assert.equal(store.availability().some(slot=>slot.id==='slot-main'),true);
  assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_id=? AND event_type='provider_payment_failed'").get(checkout.id) as {n:number}).n,1);
  assert.equal(store.cancelOrder(original.id,'staff-manager').status,'cancelled');store.resetLocal();
});

for(const tamper of ['processing','requires-payment-method','id','amount','currency','live','account','metadata','session-unbound'] as const){
  test(`asynchronous failure cannot release a hold with ${tamper} evidence`,t=>{
    const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
    const processing=processingSession(checkout);
    if(tamper!=='session-unbound')store.recordStripeSession(checkout.id,processing);
    const proof:Record<string,unknown>={...canceledIntent(checkout)};
    if(tamper==='processing')proof.status='processing';
    if(tamper==='requires-payment-method')proof.status='requires_payment_method';
    if(tamper==='id')proof.id='pi_otherPayment';
    if(tamper==='amount')proof.amount=checkout.amount_minor+1;
    if(tamper==='currency')proof.currency='eur';
    if(tamper==='live')proof.livemode=true;
    if(tamper==='account')proof.stripe_account_id='acct_otherAccount';
    if(tamper==='metadata')proof.metadata={...processing.metadata,checkout_id:'another-checkout'};
    assert.throws(()=>store.failStripeCheckout(checkout.id,processing,proof as unknown as StripePaymentIntentProof),{code:'STRIPE_SESSION_MISMATCH'});
    assert.equal(store.getStripeCheckout(checkout.id).state,'reconciliation_required');
    assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
    assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
  });
}

test('failure evidence cannot release an existing booking or regress confirmed payment',t=>{
  const first=setup();t.after(()=>first.store.close());const pending=dispatch(first.store);
  first.store.recordStripeSession(pending.checkout.id,processingSession(pending.checkout));
  first.store.db.prepare('INSERT INTO bookings(id,order_id,slot_id,customer_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('existing-stripe-booking',pending.order.id,'slot-main',pending.order.customer_id,'confirmed',new Date(initialTime).toISOString(),new Date(initialTime).toISOString());
  assert.equal(first.store.failStripeCheckout(pending.checkout.id,processingSession(pending.checkout),canceledIntent(pending.checkout)).state,'reconciliation_required');
  assert.equal(first.store.availability().some(slot=>slot.id==='slot-main'),false);
  const second=setup();t.after(()=>second.store.close());const paid=dispatch(second.store);
  second.store.recordStripePayment(paid.checkout.id,session(paid.checkout,true));
  assert.equal(second.store.failStripeCheckout(paid.checkout.id,processingSession(paid.checkout),canceledIntent(paid.checkout)).state,'paid');
  assert.deepEqual(counts(second.store,paid.order.id),{payments:1,bookings:1,ledger:1});
  assert.equal(second.store.getOrder(paid.order.id).status,'confirmed');
});

test('corroborated async failure persists event proof and releases without requiring unsupported PI cancellation',t=>{
  const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  const processing=processingSession(checkout);store.recordStripeSession(checkout.id,processing);
  assert.equal(store.failStripeCheckout(checkout.id,processing,failedIntent(checkout)).state,'failed');
  assert.equal(store.failStripeCheckout(checkout.id,processing,failedIntent(checkout)).state,'failed');
  assert.equal(store.getOrder(original.id).status,'payment_failed');assert.equal(store.availability().some(slot=>slot.id==='slot-main'),true);
  assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
  const events=store.db.prepare("SELECT data_json FROM audit_events WHERE entity_id=? AND event_type='provider_payment_failed'").all(checkout.id) as {data_json:string}[];
  assert.equal(events.length,1);
  const proof=JSON.parse(events[0].data_json);
  assert.equal(proof.failure_event.id,'evt_asyncFailed');assert.equal(proof.failure_event.session_id,'cs_test_sessionOne');
  assert.equal(proof.payment_intent_status,'requires_payment_method');assert.equal(proof.amount_received,0);
});

for(const tamper of ['missing-event','wrong-event-type','wrong-event-session','missing-error','received-funds'] as const){
  test(`async failure stays held when its proof has ${tamper}`,t=>{
    const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
    const processing=processingSession(checkout);store.recordStripeSession(checkout.id,processing);
    const proof:Record<string,unknown>={...failedIntent(checkout)};
    if(tamper==='missing-event')delete proof.failure_event;
    if(tamper==='wrong-event-type')proof.failure_event={id:'evt_asyncFailed',type:'checkout.session.completed',session_id:'cs_test_sessionOne'};
    if(tamper==='wrong-event-session')proof.failure_event={id:'evt_asyncFailed',type:'checkout.session.async_payment_failed',session_id:'cs_test_otherSession'};
    if(tamper==='missing-error')proof.last_payment_error=null;
    if(tamper==='received-funds')proof.amount_received=1;
    assert.throws(()=>store.failStripeCheckout(checkout.id,processing,proof as unknown as StripePaymentIntentProof),{code:'STRIPE_SESSION_MISMATCH'});
    assert.equal(store.availability().some(slot=>slot.id==='slot-main'),false);
    assert.deepEqual(counts(store,original.id),{payments:0,bookings:0,ledger:0});
  });
}

test('actual paid proof after failed hold release records money but repeated reconciliation never auto-books a free slot',t=>{
  const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  const processing=processingSession(checkout);store.recordStripeSession(checkout.id,processing);
  store.failStripeCheckout(checkout.id,processing,failedIntent(checkout));
  assert.equal(store.availability().some(slot=>slot.id==='slot-main'),true);
  assert.equal(store.recordStripePayment(checkout.id,session(checkout,true)).state,'reconciliation_required');
  assert.equal(store.recordStripePayment(checkout.id,session(checkout,true)).state,'reconciliation_required');
  assert.deepEqual(counts(store,original.id),{payments:1,bookings:0,ledger:1});
  assert.equal((store.db.prepare('SELECT status FROM booking_holds WHERE id=?').get(checkout.hold_id) as {status:string}).status,'released');
  assert.equal(store.getOrder(original.id).status,'reconciliation_required');assert.throws(()=>store.resetLocal(),{code:'UNSAFE_RESET'});
});

test('a raced adapter error cannot downgrade paid checkout or alter an already recorded payment',t=>{
  const {store}=setup();t.after(()=>store.close());const {checkout,order:original}=dispatch(store);
  store.recordStripePayment(checkout.id,session(checkout,true));
  assert.equal(store.markStripeCheckoutReconciliation(checkout.id,'Old webhook request timed out').state,'paid');
  assert.equal(store.getOrder(original.id).status,'confirmed');assert.deepEqual(counts(store,original.id),{payments:1,bookings:1,ledger:1});
});
