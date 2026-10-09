import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCard,Role,TaskState } from '@a2a-js/sdk';
import { ClientFactory,ClientFactoryOptions,JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import {freshFixture,onboard,audited,activate,provision,operational,ready,mcp,json,customerToken,operationScopes} from './handoru-fixture.js';

async function publish(c:Awaited<ReturnType<typeof ready>>,key='publication-one') {
  const publication=await json(await c.agent(`${c.path}/website-publications`,{},{'idempotency-key':key}),201);
  await json(await c.agent('/api/agent/site/agent-card',{publication_id:publication.id},{'idempotency-key':`write-${key}`}));
  return publication;
}
test('website card requires separate owner publication scope, bounded native write, real public card and visible link',async t=>{
  const f=await freshFixture(t),c=await onboard(f),relay=await provision(c),audit=await audited(f,c);
  assert.equal((await c.agent(`${c.path}/website-publications`,{}, {'idempotency-key':'before-approval'})).status,403);
  assert.equal((await f.publicCall('/.well-known/agent-card.json')).status,503);
  await activate(c,audit);await operational(c,audit.proposal.payload_hash,['inbox.claim','inbox.reply','cases.quote']);
  assert.equal((await c.agent(`${c.path}/website-publications`,{}, {'idempotency-key':'missing-publication-consent'})).status,403);
  assert.equal((await c.agent('/api/agent/site/agent-card',{publication_id:'fake'},{'idempotency-key':'missing-write-consent'})).status,403);
  const call=mcp(f,c.token),limited=(await json(await call('tools/list'))).result.tools.map((tool:any)=>tool.name);assert.ok(!limited.includes('website.publish_agent_card'));
  await json(await c.owner.call(`${c.path}/owner/connections/${c.connectionId}/authorize-operation`,{scopes:operationScopes,expected_epoch:1}));
  const publication=await json(await c.agent(`${c.path}/website-publications`,{},{'idempotency-key':'publication-one'}),201);
  assert.equal((await c.agent(`${c.path}/website-publications/${publication.id}/verify`,{})).status,409,'Prepared is not published');
  const written=(await json(await call('tools/call',{name:'website.publish_agent_card',arguments:{publication_id:publication.id,idempotency_key:'write-publication-one'}}))).result;
  assert.equal(written.isError,false);assert.equal(written.structuredContent.visible_link,true);
  const replay=await json(await c.agent('/api/agent/site/agent-card',{publication_id:publication.id},{'idempotency-key':'write-publication-one'}));assert.deepEqual(written.structuredContent,replay);
  const response=await f.publicCall('/.well-known/agent-card.json'),card=await json(response),etag=response.headers.get('etag');
  assert.equal(response.headers.get('cache-control'),'no-cache, max-age=0, must-revalidate');assert.ok(etag);
  assert.equal(card.supportedInterfaces[0].url,relay.endpoint);assert.equal(card.supportedInterfaces[0].protocolVersion,'1.0');assert.equal(card.supportedInterfaces[0].protocolBinding,'JSONRPC');
  assert.deepEqual(card.securitySchemes,{bearer:{httpAuthSecurityScheme:{scheme:'Bearer'}}});assert.deepEqual(card.securityRequirements,[{schemes:{bearer:{list:[]}}}]);
  assert.deepEqual(card.capabilities,{streaming:false,pushNotifications:false});assert.match(card.description,/Fictional/);
  const serialized=JSON.stringify(card);for(const privateValue of [c.token,'auto_discount_bps','deposit_minor','source_authority'])assert.ok(!serialized.includes(privateValue));
  const home=await(await f.publicCall('/')).text();assert.match(home,/<a[^>]*href="\/\.well-known\/agent-card\.json"[^>]*>Pro agenty/);
  assert.equal((await f.publicCall('/.well-known/agent-card.json',undefined,{'if-none-match':etag!,'cache-control':'max-age=0'})).status,304);
  const verified=await json(await c.agent(`${c.path}/website-publications/${publication.id}/verify`,{}));assert.equal(verified.state,'verified');
  assert.equal((await c.agent('/api/agent/site/agent-card',{publication_id:'nonexistent'},{'idempotency-key':'wrong-publication'})).status,404);
  await json(await c.owner.call(`${c.path}/owner/connections/${c.connectionId}/revoke`,{}));
  const withdrawn=await f.publicCall('/.well-known/agent-card.json');assert.equal(withdrawn.status,503);assert.equal(withdrawn.headers.get('cache-control'),'no-store');
  assert.ok(!(await(await f.publicCall('/')).text()).includes('class="handoru-agent-card-link"'));
});

test('published managed endpoint is genuinely A2A and revalidation discovers changed endpoint on next run',async t=>{
  const f=await freshFixture(t,{unified:true}),c=await ready(f);await publish(c);
  const firstResponse=await f.publicCall('/.well-known/agent-card.json'),wire=await json(firstResponse),firstTag=firstResponse.headers.get('etag')!;
  const authenticatedFetch:typeof fetch=(input,init)=>{const headers=new Headers(init?.headers);headers.set('authorization',`Bearer ${customerToken}`);return fetch(input,{...init,headers});};
  const factory=new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default,{transports:[new JsonRpcTransportFactory({fetchImpl:authenticatedFetch})],preferredTransports:['JSONRPC']}));
  // Customer gets only the business website; the endpoint comes from its fetched public card.
  const client=await factory.createFromAgentCard(AgentCard.fromJSON(wire));
  const sent=await client.sendMessage({tenant:'',metadata:{},message:{messageId:'managed-card-discovery-regression',role:Role.ROLE_USER,parts:[{content:{$case:'text',value:'Synthetic customer asks for a tyre change quote.'},filename:'',mediaType:'text/plain',metadata:{}}],taskId:'',contextId:'',extensions:[],metadata:{},referenceTaskIds:[]},configuration:{acceptedOutputModes:['text/plain'],returnImmediately:true,historyLength:undefined,taskPushNotificationConfig:undefined}});
  assert.ok('id' in sent);const taskId=sent.id;
  let items:any[]=[];
  for(let attempt=0;attempt<20&&!items.length;attempt++){items=(await json(await c.agent(`/relay/${c.relay.id}/bot/inbox`))).items;if(!items.length)await new Promise(done=>setTimeout(done,20));}
  assert.equal(items.length,1);assert.equal(items[0].task_id,taskId);assert.equal(items[0].business_id,c.businessId);assert.ok(items[0].lease_token);
  await json(await c.agent(`/relay/${c.relay.id}/bot/reply`,{work_item_id:items[0].work_item_id,text:'Synthetic native relay transport reply.',state:'completed',lease_token:items[0].lease_token,claim_generation:items[0].claim_generation}));
  let task=await client.getTask({id:taskId,tenant:'',historyLength:undefined});
  for(let attempt=0;attempt<20&&task.status?.state!==TaskState.TASK_STATE_COMPLETED;attempt++){await new Promise(done=>setTimeout(done,20));task=await client.getTask({id:taskId,tenant:'',historyLength:undefined});}
  assert.equal(task.status?.state,TaskState.TASK_STATE_COMPLETED);assert.match(JSON.stringify(task),/Synthetic native relay transport reply/);
  // A deployment changes the managed endpoint. It is fixture administration, not agent write access.
  const newEndpoint=`${c.relay.endpoint}?deployment_revision=2`;
  f.store.db.prepare('UPDATE handoru_relays SET endpoint=? WHERE id=?').run(newEndpoint,c.relay.id);
  await publish(c,'publication-after-endpoint-change');
  const changed=await f.publicCall('/.well-known/agent-card.json',undefined,{'if-none-match':firstTag});assert.equal(changed.status,200);
  assert.notEqual(changed.headers.get('etag'),firstTag);assert.equal((await changed.json()).supportedInterfaces[0].url,newEndpoint);
  assert.equal(f.cfg.publicUrl,f.base,'Customer contact website was not changed');
});
