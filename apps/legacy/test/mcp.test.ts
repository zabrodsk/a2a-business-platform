import test from 'node:test';
import assert from 'node:assert/strict';
import {freshFixture,onboard,ready,mcp,json,service,clock} from './handoru-fixture.js';

test('MCP negotiates the pinned transport with the dedicated service credential and excludes human approval tools',async t=>{
  const f=await freshFixture(t),c=await onboard(f),call=mcp(f,c.token);
  const initialized=await json(await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'scripted-regression-client',version:'1.0'}}));
  assert.equal(initialized.result.protocolVersion,'2025-06-18');assert.equal(initialized.result.capabilities.tools.listChanged,false);
  const listed=(await json(await call('tools/list'))).result.tools;
  assert.deepEqual(listed.map((tool:any)=>tool.name),['catalog']);
  assert.ok(listed.every((tool:any)=>!/(approve|activate|transfer)/.test(tool.name)));
  const catalogue=await json(await call('tools/call',{name:'catalog',arguments:{}}));assert.equal(catalogue.result.isError,false);
  assert.deepEqual(catalogue.result.structuredContent,await json(await c.agent('/api/services')));
  const denied=await json(await call('tools/call',{name:'quote.create',arguments:{case_id:'not-owned',slot_id:'slot-main',discount_bps:0,idempotency_key:'audit-must-not-write'}}));
  assert.equal(denied.result.isError,true);assert.match(denied.result.content[0].text,/FORBIDDEN/);
  const forged=await json(await call('tools/call',{name:'owner.activate_rulebook',arguments:{version:1}}),400);assert.equal(forged.error.code,-32602);
  const wrongVersion=await json(await call('ping',{}, {'mcp-protocol-version':'2099-01-01'}),400);assert.equal(wrongVersion.error.code,-32600);
  assert.equal((await f.client({authorization:`Bearer ${c.token}`,accept:'application/json'})('/mcp',{jsonrpc:'2.0',id:1,method:'ping'})).status,406);
  const notification=await f.client({authorization:`Bearer ${c.token}`,accept:'application/json, text/event-stream'})('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(notification.status,202);
  assert.equal((await f.publicCall('/mcp',{jsonrpc:'2.0',id:1,method:'initialize'})).status,401);
  assert.equal((await c.legacyOwner.call('/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},{accept:'application/json, text/event-stream'})).status,401,'Legacy browser admin is not the agent service account');
});

test('MCP and HTTP share quote policy/idempotency and revoke an already negotiated credential immediately',async t=>{
  const f=await freshFixture(t),c=await ready(f),call=mcp(f,c.token);
  await json(await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'scripted-client',version:'1'}}));
  const tools=(await json(await call('tools/list'))).result.tools.map((tool:any)=>tool.name);
  assert.ok(tools.includes('quote.create'));assert.ok(tools.includes('orders.checkout'));assert.ok(!tools.includes('owner.approve'));
  const opened=(await json(await f.customer('/api/agent/cases',{service_spec:service}),201)).case;
  const args={case_id:opened.id,slot_id:'slot-main',discount_bps:300,idempotency_key:'shared-http-mcp-quote'};
  const viaMcp=(await json(await call('tools/call',{name:'quote.create',arguments:args}))).result;
  assert.equal(viaMcp.isError,false);
  const viaHttp=await json(await c.agent(`/api/agent/cases/${opened.id}/quotes`,{slot_id:args.slot_id,discount_bps:args.discount_bps},{'idempotency-key':args.idempotency_key}),201);
  assert.equal(viaMcp.structuredContent.quote.id,viaHttp.quote.id);
  assert.equal(viaHttp.quote.price.discount_bps,300);
  const changed=await c.agent(`/api/agent/cases/${opened.id}/quotes`,{slot_id:'slot-main',discount_bps:200},{'idempotency-key':args.idempotency_key});assert.equal(changed.status,409);
  const forbiddenMcp=(await json(await call('tools/call',{name:'quote.create',arguments:{...args,discount_bps:1001,idempotency_key:'hard-limit-mcp'}}))).result;
  const forbiddenHttp=await json(await c.agent(`/api/agent/cases/${opened.id}/quotes`,{slot_id:'slot-main',discount_bps:1001},{'idempotency-key':'hard-limit-http'}),403);
  assert.equal(forbiddenMcp.isError,true);assert.equal(forbiddenMcp.structuredContent.error.code,forbiddenHttp.error.code);
  const invalid=await json(await call('tools/call',{name:'quote.create',arguments:{...args,activate:true}}),400);assert.equal(invalid.error.code,-32602);
  await json(await c.owner.call(`${c.path}/owner/connections/${c.connectionId}/revoke`,{}));
  assert.equal((await call('tools/list')).status,401);
  assert.equal((await c.agent('/api/agent/availability')).status,401);
});

test('MCP checkout consumes the same customer approval and replays the same native payment intent through HTTP',async t=>{
  const f=await freshFixture(t),c=await ready(f),call=mcp(f,c.token),human=await f.login('customer-a');
  const opened=(await json(await f.customer('/api/agent/cases',{service_spec:service}),201)).case;
  const quote=(await json(await call('tools/call',{name:'quote.create',arguments:{case_id:opened.id,slot_id:'slot-main',discount_bps:0,idempotency_key:'mcp-checkout-quote'}}))).result.structuredContent.quote;
  const mandate=(await json(await f.customer('/api/agent/mandates',{case_id:opened.id,mode:'book',service_spec:service,max_total_minor:250000,max_deposit_minor:50000,payment_mode:'deposit',latest_service_end:'2026-10-20T22:00:00Z',expires_at:new Date(clock().getTime()+3600000).toISOString(),allow_extras:false,currency:'CZK',network:'local',asset:'lovelace',max_asset_quantity:'25000000',max_network_fee:'2000000',mapping_version:'demo-map-v1',seller_id:'pneu007-demo'}),201)).mandate;
  assert.equal((await f.customer(`/api/agent/cases/${opened.id}/accept`,{quote_id:quote.id,mandate_id:mandate.id})).status,403,'Bot cannot accept a pending human mandate');
  await json(await human.call(`/api/admin/mandates/${mandate.id}/approve`,{}));
  const accepted=await json(await f.customer(`/api/agent/cases/${opened.id}/accept`,{quote_id:quote.id,mandate_id:mandate.id}));
  const args={order_id:accepted.order.id,idempotency_key:'shared-mcp-http-checkout'};
  const checked=(await json(await call('tools/call',{name:'orders.checkout',arguments:args}))).result;
  assert.equal(checked.isError,false);assert.equal(checked.structuredContent.intent.authorization.mandate_id,mandate.id);
  const repeated=await json(await c.agent(`/api/agent/orders/${accepted.order.id}/checkout`,{},{'idempotency-key':args.idempotency_key}));
  assert.equal(checked.structuredContent.intent.intent_id,repeated.intent.intent_id);assert.equal(repeated.booking.status,'confirmed');
  assert.equal(f.store.listPaymentIntents().length,1);assert.equal(repeated.simulation,true,'Local simulator is never labelled real Masumi');
});
