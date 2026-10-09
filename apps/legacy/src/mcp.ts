import express, { type Request } from 'express';
import { BusinessError } from '../../../packages/contracts/index.js';
import type { LegacyAuth } from './auth.js';
import type { HandoruStore } from './handoru/store.js';

const objectSchema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string',minLength:1,maxLength:200};
const tools=[
  {name:'catalog',description:'Read the public service catalog.',path:'/api/services',method:'GET',scope:'audit.read',inputSchema:objectSchema({})},
  {name:'availability',description:'Read current native service slots.',path:'/api/agent/availability',method:'GET',scope:'inbox.claim',inputSchema:objectSchema({service_id:string,from:string,to:string})},
  {name:'case.read',description:'Read a case assigned to this business.',path:'/api/agent/cases/:case_id',method:'GET',scope:'inbox.claim',inputSchema:objectSchema({case_id:string},['case_id'])},
  {name:'order.read',description:'Read native order, booking and payment status.',path:'/api/agent/orders/:order_id',method:'GET',scope:'inbox.claim',inputSchema:objectSchema({order_id:string},['order_id'])},
  {name:'quote.create',description:'Create an immutable quote. Above the rulebook limit this also requests a quote-bound human exception.',path:'/api/agent/cases/:case_id/quotes',method:'POST',scope:'cases.quote',inputSchema:objectSchema({case_id:string,slot_id:string,discount_bps:{type:'integer',minimum:0,maximum:10000},idempotency_key:string},['case_id','slot_id','discount_bps','idempotency_key'])},
  {name:'orders.checkout',description:'Checkout a stored customer acceptance within its human-approved mandate. No arbitrary transfers.',path:'/api/agent/orders/:order_id/checkout',method:'POST',scope:'orders.checkout',inputSchema:objectSchema({order_id:string,idempotency_key:string},['order_id','idempotency_key'])},
  {name:'website.publish_agent_card',description:'Publish only the approved managed card descriptor and visible link, within owner website consent.',path:'/api/agent/site/agent-card',method:'POST',scope:'website.agent-card.publish',inputSchema:objectSchema({publication_id:string,idempotency_key:string},['publication_id','idempotency_key'])},
] as const;

/** Stateless Streamable HTTP (MCP 2025-06-18); all tools use the exact HTTP policy path. */
export function pneuMcp(auth:LegacyAuth,h:HandoruStore) {
  const r=express.Router();
  r.use(express.json({limit:'64kb'}),auth.middleware,(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try {
      auth.checkOrigin(req);
      if(!/^Bearer\s+\S+/i.test(req.header('authorization')??'')||!req.legacyActor?.connection_id)throw new BusinessError('UNAUTHENTICATED','A dedicated agent service credential is required.',401);
      h.authorize(req.legacyActor,req.legacyActor.business_id!,'audit.read');next();
    }catch(error){next(error);}
  });
  r.get('/',(_req,res)=>res.set('Allow','POST').status(405).end());
  r.delete('/',(_req,res)=>res.set('Allow','POST').status(405).end());
  r.post('/',async(req,res)=>{
    const message=req.body;
    const error=(code:number,message:string,status=400)=>res.status(status).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code,message}});
    if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return void error(-32600,'Invalid JSON-RPC request.');
    const version=req.header('mcp-protocol-version');
    if(version&&version!=='2025-06-18')return void error(-32600,'Unsupported MCP protocol version.');
    if(!req.accepts('application/json')||!req.header('accept')?.includes('text/event-stream'))return void error(-32600,'Accept application/json and text/event-stream.',406);
    if(message.id===undefined){if(!['notifications/initialized','notifications/cancelled'].includes(message.method))return void error(-32601,'Unsupported notification.');res.status(202).end();return;}
    if(!['string','number'].includes(typeof message.id))return void error(-32600,'Invalid request id.');
    const result=(value:unknown)=>res.json({jsonrpc:'2.0',id:message.id,result:value});
    if(message.method==='initialize')return void result({protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'pneu007-native-tools',version:'1.0.0'},instructions:'Use your owner-approved service account. Owner/customer approvals are not tools. HTTP and MCP share policy.'});
    if(message.method==='ping')return void result({});
    if(message.method==='tools/list')return void result({tools:tools.filter(t=>req.legacyActor!.scopes?.includes(t.scope)).map(({name,description,inputSchema,method})=>({name,description,inputSchema,annotations:{readOnlyHint:method==='GET',destructiveHint:method!=='GET',openWorldHint:true}}))});
    if(message.method!=='tools/call')return void error(-32601,'Method not found.',404);
    const tool=tools.find(t=>t.name===message.params?.name),args=message.params?.arguments??{};
    if(!tool)return void error(-32602,'Unknown tool.');
    const schema=tool.inputSchema;
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))return void error(-32602,'Invalid tool arguments.');
    for(const [key,value] of Object.entries(args)){
      if(key==='discount_bps'? !Number.isSafeInteger(value)||Number(value)<0||Number(value)>10000 : typeof value!=='string'||!value||value.length>200)return void error(-32602,'Invalid tool argument type.');
    }
    try {
      const principal=req.legacyActor!;h.authorize(principal,principal.business_id!,tool.scope,tool.scope!=='audit.read');
      let path:string=tool.path;const body={...args};
      for(const key of ['case_id','order_id'])if(path.includes(`:${key}`)){path=path.replace(`:${key}`,encodeURIComponent(String(body[key])));delete body[key];}
      const key=body.idempotency_key;delete body.idempotency_key;
      if(tool.method==='GET'&&Object.keys(body).length)path+=`?${new URLSearchParams(body)}`;
      // The socket's server port is trusted; request Host/URL is never an outbound destination.
      const response=await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`,{method:tool.method,headers:{authorization:req.header('authorization')!,'content-type':'application/json',...(key?{'idempotency-key':String(key)}:{})},body:tool.method==='POST'?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(60_000)});
      const data=await response.json();if(response.ok)h.db.prepare('INSERT INTO handoru_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`mcp_verified:${principal.connection_id}`,JSON.stringify({protocol_version:'2025-06-18',tool:tool.name,observed_at:h.now().toISOString()}));h.authorize(principal,principal.business_id!,tool.scope,tool.scope!=='audit.read');
      result({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:!response.ok});
    }catch(cause){const code=cause instanceof BusinessError?cause.code:'TOOL_FAILED';result({content:[{type:'text',text:JSON.stringify({error:{code}})}],isError:true});}
  });
  return r;
}
