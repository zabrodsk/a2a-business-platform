import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const run=promisify(execFile);
const cli=resolve(import.meta.dirname,'../dist/garage.mjs');
const token='handoru-business-service-token-test-only';
const business_id='business-test',connection_id='connection-test',principal_id='principal-test';
const identity={role:'business_agent',business_id,connection_id,principal_id,state:'active',scopes:['audit.read','cases.quote'],execution_epoch:1};

type Request={method:string;url:string;authorization?:string;idempotency_key?:string};
async function fixture(task:(context:{config:string;credential:string;origin:string;requests:Request[];
  invoke:(args:string[])=>Promise<{stdout:string;stderr:string}>;
  respond:(handler:(response:ServerResponse)=>void)=>void;
  saveCredential:(value:unknown)=>void;
})=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'garage-handoru-enrollment-'));
  const config=join(dir,'private','garage.json'),credential=join(dir,'handoru-service.json');
  const requests:Request[]=[];
  let handler=(response:ServerResponse)=>{response.end(JSON.stringify(identity));};
  const server=createServer((req,res)=>{requests.push({method:req.method!,url:req.url!,authorization:req.headers.authorization,idempotency_key:req.headers['idempotency-key'] as string|undefined});handler(res);});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  const saveCredential=(value:unknown)=>writeFileSync(credential,JSON.stringify(value),{mode:0o600});
  saveCredential({url:origin,token,business_id,connection_id});
  try { await task({config,credential,origin,requests,saveCredential,respond:next=>{handler=next;},
    invoke:args=>run(process.execPath,[cli,...args],{env:{...process.env,GARAGE_CONFIG:config,PNEU007_TOOL_TOKEN:'',PNEU007_BUSINESS_URL:''}}),
  }); } finally { server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true}); }
}
const enroll=(credential:string)=>['enroll','--credential-file',credential,'--allow-http-localhost'];

test('scoped Handle credential enrollment verifies identity then atomically saves private business bindings',async()=>{
  await fixture(async({config,credential,origin,requests,invoke,respond})=>{
    const result=await invoke(enroll(credential));
    assert.match(result.stdout,/enrolled/);assert.ok(!result.stdout.includes(token));assert.equal(result.stderr,'');
    assert.deepEqual(requests[0],{method:'GET',url:'/api/handoru/v1/me',authorization:`Bearer ${token}`,idempotency_key:undefined});
    assert.equal(statSync(config).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(readFileSync(config,'utf8')),{role:'business_agent',url:origin,token,business_id,connection_id,principal_id});
    respond(response=>{response.end(JSON.stringify({reflected:token}));});
    const profile=await invoke(['profile','--allow-http-localhost']);
    assert.equal(profile.stdout,'{"reflected":"[REDACTED]"}\n');
    assert.equal(requests.at(-1)!.url,'/api/agent/profile');
    assert.equal(requests.at(-1)!.authorization,`Bearer ${token}`);
    const count=requests.length;
    await assert.rejects(invoke(['--url','https://another-business.example','profile','--allow-http-localhost']),/TOKEN is required/);
    assert.equal(requests.length,count);
    chmodSync(config,0o644);
    respond(response=>{response.end(JSON.stringify(identity));});
    await invoke(enroll(credential));
    assert.equal(statSync(config).mode&0o777,0o600);
  });
});

test('old redeem URL and unbound credential files are rejected before any network request',async()=>{
  await fixture(async({config,credential,origin,requests,invoke,saveCredential})=>{
    await assert.rejects(invoke(['enroll',`${origin}/agent-enrollments/${'a'.repeat(43)}`,'--allow-http-localhost']),/removed.*handle bootstrap/);
    for(const value of [null,[],{url:origin,token},{url:origin,token,business_id},
      {url:`${origin}/api`,token,business_id,connection_id},{url:'http://remote.example',token,business_id,connection_id},
      {url:'https://user:password@example.com',token,business_id,connection_id},
      {url:origin,token:'short',business_id,connection_id},{url:origin,token:`${token}\n`,business_id,connection_id}]) {
      saveCredential(value);await assert.rejects(invoke(enroll(credential)),/Invalid service credential file/);
    }
    assert.equal(requests.length,0);assert.equal(existsSync(config),false);
    mkdirSync(dirname(config),{recursive:true});
    writeFileSync(config,JSON.stringify({role:'business_agent',url:origin,token}),{mode:0o600});
    await assert.rejects(invoke(['profile','--allow-http-localhost']),/Invalid local garage configuration/);
    assert.equal(requests.length,0,'Legacy unbound saved credential must not be sent');
  });
});

test('wrong role, mismatched business/connection, revoked state and missing service claims cannot enroll',async()=>{
  await fixture(async({config,credential,invoke,respond})=>{
    for(const value of [null,[],{...identity,role:'owner_agent'},{...identity,role:'customer_agent'},
      {...identity,business_id:'foreign-business'},{...identity,connection_id:'foreign-connection'},
      {...identity,state:'revoked'},{...identity,state:'suspended'},{...identity,principal_id:undefined},
      {...identity,scopes:undefined},{...identity,execution_epoch:-1},{...identity,execution_epoch:undefined}]) {
      respond(response=>response.end(JSON.stringify(value)));
      await assert.rejects(invoke(enroll(credential)),error=>{assert.match(String(error),/Enrollment failed/);assert.ok(!String(error).includes(token));return true;});
      assert.equal(existsSync(config),false);
    }
  });
});

test('verification redirects and server errors never save or expose the service bearer',async()=>{
  await fixture(async({config,credential,origin,requests,invoke,respond})=>{
    respond(response=>{response.statusCode=302;response.setHeader('location',`${origin}/leak`);response.end(token);});
    await assert.rejects(invoke(enroll(credential)),/Enrollment failed/);
    assert.equal(requests.length,1);assert.equal(existsSync(config),false);
    respond(response=>{response.statusCode=401;response.end(token);});
    await assert.rejects(invoke(enroll(credential)),error=>{assert.ok(!String(error).includes(token));return true;});
    assert.equal(existsSync(config),false);
  });
});

test('named and raw mutations retain caller-supplied operation keys across retries',async()=>{
  await fixture(async({credential,requests,invoke,respond})=>{
    await invoke(enroll(credential));
    const payload=join(credential+'.quote.json');writeFileSync(payload,'{"discount_bps":300}');
    respond(response=>response.end('{"ok":true}'));
    for(let retry=0;retry<2;retry++)await invoke(['quote','case-test','--data-file',payload,'--idempotency-key','same-quote-operation','--allow-http-localhost']);
    assert.deepEqual(requests.slice(-2).map(r=>({method:r.method,url:r.url,key:r.idempotency_key})),[
      {method:'POST',url:'/api/agent/cases/case-test/quotes',key:'same-quote-operation'},
      {method:'POST',url:'/api/agent/cases/case-test/quotes',key:'same-quote-operation'},
    ]);
    await invoke(['call','POST','/api/agent/orders/order-test/checkout','--idempotency-key','same-checkout-operation','--allow-http-localhost']);
    assert.equal(requests.at(-1)!.idempotency_key,'same-checkout-operation');
    await invoke(['call','POST','/api/example','--allow-http-localhost']);
    assert.equal(requests.at(-1)!.idempotency_key,undefined,'CLI must not invent a different operation key per retry');
    const count=requests.length;
    await assert.rejects(invoke(['profile','--idempotency-key','not-a-mutation','--allow-http-localhost']),/mutating requests/);
    assert.equal(requests.length,count);
  });
});
