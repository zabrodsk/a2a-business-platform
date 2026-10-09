import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8').replace(/^import .*?;\n/, '');
const mandate = {
  id: 'mandate-test', service_spec: {service_id:'tyre_change',vehicle_type:'personal',wheel_count:4,wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:true},
  status:'pending',mode:'book',max_total_minor:250000,max_deposit_minor:50000,payment_mode:'deposit',latest_service_end:'2099-10-17T22:00:00Z',expires_at:'2099-10-09T10:00:00Z',network:'Preprod',max_asset_quantity:'25000000',max_network_fee:'2000000',seller_id:'pneu007-seller',mapping_version:'demo-map-v1',proposed_by:'customer-bot',
};
async function page(options: {actor?: {id:string;role:string}|null;pathname?:string;search?:string;mandates?:unknown[];postError?:string} = {}) {
  const actor = options.actor === undefined ? {id:'customer-a',role:'human_customer'} : options.actor;
  const elements = new Map<string, {innerHTML:string;textContent:string;style:Record<string,string>;addEventListener:()=>void}>();
  const element = (id:string) => {
    if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',style:{},addEventListener:()=>{}});
    return elements.get(id)!;
  };
  const removedFooterLinks: string[] = [];
  const footerLinks = ['/', '/kontakt', '/.well-known/agent-card.json', '/agent/access', '/agent/mandates?mandate_id=mandate-test', '/admin', '/handle', '/handoru'].map(href => ({
    href, removed: false,
    remove() { this.removed = true; removedFooterLinks.push(href); },
  }));
  const listeners = new Map<string,(event:unknown)=>Promise<void>>();
  const requests: {path:string;options?:{method?:string;body?:unknown}}[] = [];
  const mandates = options.mandates ?? [structuredClone(mandate)];
  const context = {
    location:{pathname:options.pathname ?? '/agent/mandates',search:options.search ?? '?mandate_id=mandate-test'},URLSearchParams,Intl,Date,BigInt,
    document:{querySelector:()=>element('main'),querySelectorAll:(selector:string)=> {
      const hrefs = selector.split(',').map(part => {
        const match = /^footer a\[href="([^"]+)"\]$/.exec(part.trim());
        assert.ok(match, `Unsupported footer selector: ${part}`);
        return match[1]!;
      });
      return footerLinks.filter(link => hrefs.includes(link.href));
    },getElementById:element,addEventListener:(name:string,listener:(event:unknown)=>Promise<void>)=>listeners.set(name,listener)},
    api: async (path:string, input?:{method?:string;body?:unknown}) => {
      requests.push({path,options:input});
      if(path === '/api/session') return {actor};
      if(path === '/api/agent/identities') return {identities:[]};
      if(path === '/api/admin/mandates') return {mandates};
      if(path === '/api/admin/mandates/mandate-test/approve') {
        if(options.postError) throw new Error(options.postError);
        (mandates[0] as typeof mandate).status='approved';return {mandate:mandates[0]};
      }
      throw new Error(`Unexpected request ${path}`);
    },
    list:(data:Record<string,unknown>,key:string)=>data[key] ?? [],
    esc:(value:unknown)=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)),
    date:(value:string)=>value,
    setTimeout:()=>{},
  };
  await runInNewContext(`(async()=>{${source}})()`,context);
  return {
    html:()=>element('content').innerHTML,sessionHtml:()=>element('session').innerHTML,removedFooterLinks,remainingFooterLinks:()=>footerLinks.filter(link=>!link.removed).map(link=>link.href),main:()=>element('main').innerHTML,requests,
    inlineError:()=>element('mandate-error').textContent,
    approve:async(id='mandate-test')=> {
      const button={dataset:{action:'customer-mandate',id},disabled:false};
      await listeners.get('click')!({target:{closest:(selector:string)=>selector === '[data-action]' ? button : null}});
    },
  };
}

test('customer sees scope and independent CZK, asset and fee limits without approving on page load',async()=>{
  const p=await page();
  for(const text of ['Přezutí pneumatik','4 kola','2\u00a0500,00','500,00','25 test ADA (25000000 lovelace)','2 test ADA (2000000 lovelace)','Cardano Preprod','Dokončení nejpozději','Samotné propojení agenta není souhlasem','Schválit rezervaci a testovací platbu']) assert.ok(p.html().includes(text),text);
  assert.ok(!p.main().includes('data-tab'));assert.ok(!p.html().includes('<pre>'));
  assert.deepEqual(p.requests.map(r=>r.path),['/api/session','/api/admin/mandates']);
  await p.approve();
  const writes=p.requests.filter(r=>r.options?.method === 'POST');
  assert.equal(writes.length,1);assert.equal(writes[0]!.path,'/api/admin/mandates/mandate-test/approve');
  assert.match(p.html(),/Váš souhlas je uložen/);assert.doesNotMatch(p.html(),/data-action="customer-mandate"/);
});

test('authentication, missing mandate, account mismatch and expiry never offer approval',async()=>{
  const scenarios=[
    {options:{actor:null},message:/Přihlaste se jako zákazník/},
    {options:{actor:{id:'owner',role:'owner'}},message:/pouze zákazník/},
    {options:{search:''},message:/Chybí odkaz/},
    {options:{mandates:[]},message:/nebylo nalezeno pro váš účet/},
    {options:{mandates:[{...mandate,expires_at:'2000-01-01T00:00:00Z'}]},message:/Platnost tohoto oprávnění vypršela/},
  ];
  for(const scenario of scenarios) {
    const p=await page(scenario.options);assert.match(p.html(),scenario.message);assert.doesNotMatch(p.html(),/data-action="customer-mandate"/);assert.equal(p.requests.filter(r=>r.options?.method === 'POST').length,0);
  }
});

test('recommendation-only approval states no reservation or payment authority and escapes agent data',async()=>{
  const p=await page({mandates:[{...mandate,mode:'recommend',proposed_by:'<img src=x onerror=alert(1)>',seller_id:'<script>seller</script>'}]});
  assert.match(p.html(),/Nesmí vytvořit rezervaci ani provést platbu/);assert.match(p.html(),/Schválit pouze doporučení/);
  assert.match(p.html(),/&lt;img/);assert.match(p.html(),/&lt;script/);assert.doesNotMatch(p.html(),/<img|<script/);
});

test('approval errors remain visible and mismatched click cannot target another mandate',async()=>{
  const p=await page({postError:'MANDATE_EXPIRED'});
  await p.approve('another-mandate');assert.equal(p.requests.filter(r=>r.options?.method === 'POST').length,0);
  await p.approve();assert.equal(p.inlineError(),'MANDATE_EXPIRED');
});


test('customer pages use friendly account labels and remove only operator footer links',async()=>{
  for(const pathname of ['/agent/claim','/agent/access','/agent/mandates']) {
    const p=await page({pathname});
    assert.match(p.sessionHtml(),/Zákaznický účet/);
    assert.doesNotMatch(p.sessionHtml(),/customer-a|human_customer/);
    assert.deepEqual(p.removedFooterLinks,['/admin','/handle','/handoru']);
    assert.deepEqual(p.remainingFooterLinks(),['/', '/kontakt', '/.well-known/agent-card.json', '/agent/access', '/agent/mandates?mandate_id=mandate-test']);
  }
  const owner=await page({pathname:'/admin',actor:{id:'owner-account',role:'owner'}});
  assert.match(owner.sessionHtml(),/owner-account · owner/);
  assert.deepEqual(owner.removedFooterLinks,[]);
  assert.deepEqual(owner.remainingFooterLinks(),['/', '/kontakt', '/.well-known/agent-card.json', '/agent/access', '/agent/mandates?mandate_id=mandate-test', '/admin', '/handle', '/handoru']);
});
