import { api, list, escapeHTML as esc, money, date } from './api.js';
const defaults = {service_id:'tyre_change',vehicle_type:'personal',wheel_size_inches:18,rim_type:'alu',runflat:false,tpms:false,wheel_count:4};
const labels = {tyre_change:'Přezutí pneumatik',wheel_swap:'Výměna kompletních kol',personal:'Osobní auto',suv:'SUV / MPV / 4×4',van:'Dodávka',steel:'Plechové disky',alu:'Hliníkové disky',diameter:'Průměr disku',runflat:'Runflat',tpms:'TPMS'};
const paymentLabels = {created:'Platba vytvořena',purchase_requested:'Nákup požadován, čeká na ověření',escrow_funded:'Prostředky v escrow',result_submitted:'Výsledek předán, čeká na vypořádání',seller_paid:'Výplata prodejci ověřena',refund_requested:'Refund požadován',refunded:'Refund ověřen',failed:'Platba selhala',reconciliation_required:'Nejasný stav, nutná kontrola'};
let locationId = 'location-007';
let checkoutProvider = new URLSearchParams(location.search).get('payment') === 'link' ? 'stripe' : 'masumi';
let actor, config, orderData, slots = [], quote, stage = 1, selectedSlot = '', mode = 'deposit', contact = {name:'',email:'',phone:''}, busy = false, pageError = '';
let spec; try { spec = JSON.parse(sessionStorage.getItem('pneu007-service-spec')) || defaults; } catch { spec = defaults; }
const orderId = location.pathname.startsWith('/objednavka/') ? decodeURIComponent(location.pathname.split('/')[2]) : null;
const showJSON = data => `<pre class="live-json">${esc(JSON.stringify(data,null,2))}</pre>`;
const slotDate = slot => date(slot.start_at ?? slot.start);
const slotEnd = slot => date(slot.end_at ?? slot.end);
function notice(text) { const el=document.createElement('div');el.className='live-announce';el.setAttribute('role','status');el.textContent=text;document.body.append(el);setTimeout(()=>el.remove(),5000); }
function modal(title, body) { const el=document.createElement('dialog');el.className='live-dialog';el.innerHTML=`<h2>${title}</h2>${body}`;document.body.append(el);el.showModal();el.addEventListener('close',()=>el.remove());el.querySelector('[data-dialog-close]')?.addEventListener('click',()=>el.close());return el; }
async function refreshSession() {
  const data=await api('/api/session');actor=data.actor;
  const catalog=await api('/api/services');locationId=catalog.location_id || locationId;
  document.querySelectorAll('.live-session').forEach(el=>{el.innerHTML=actor?`<span>${esc(actor.id)}</span><button class="btn-q" data-live-logout>Odhlásit</button>`:'<button class="btn-q" data-live-login>Přihlásit se</button>';});
}
function login() {
  if(actor){const dialog=modal('Váš účet',`<p>Přihlášeno jako ${esc(actor.id)} · ${esc(actor.role)}</p><div class="live-actions"><button data-live-logout>Odhlásit se</button><button data-dialog-close>Zavřít</button></div>`);dialog.querySelector('[data-live-logout]').addEventListener('click',()=>dialog.close());return;}
  const dialog=modal('Přihlášení',`<p>Pro nákup použijte zákaznický účet. Demo přístupové údaje jsou v místním návodu projektu.</p><form id="live-login"><label>Uživatelské jméno<input name="username" autocomplete="username" placeholder="customer-a" required></label><label>Heslo<input type="password" name="password" autocomplete="current-password" required></label><p class="live-error" role="alert"></p><div class="live-actions"><button type="submit">Přihlásit</button><button type="button" data-dialog-close>Zavřít</button></div></form>`);
  dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{await api('/api/login',{method:'POST',body:Object.fromEntries(new FormData(event.target))});await refreshSession();dialog.close();if(document.getElementById('live-checkout'))await checkout();}catch(error){dialog.querySelector('.live-error').textContent=error.message;}finally{button.disabled=false;}});
}
function inquiry() {
  const dialog=modal('Nezávazná poptávka',`<p>Konfigurace z kalkulátoru se odešle do pneuservisu. Tento krok nerezervuje termín ani nespouští platbu.</p><form><label>Jméno<input name="name" autocomplete="name"></label><label>E-mail<input type="email" name="email" autocomplete="email" required></label><label>Telefon<input type="tel" name="phone" autocomplete="tel" required></label><label>Provozovna<input value="Pneu 007 · testovací provozovna" disabled></label><p class="live-error" role="alert"></p><div class="live-actions"><button type="submit">Odeslat poptávku</button><button type="button" data-dialog-close>Zavřít</button></div></form>`);
  dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{const selected=JSON.parse(sessionStorage.getItem('pneu007-service-spec'))||defaults;const data=await api('/api/inquiries',{method:'POST',body:{...Object.fromEntries(new FormData(event.target)),service_spec:selected,location_id:locationId}});dialog.innerHTML=`<h2>Poptávka přijata</h2><p>Poptávka ${esc(data.inquiry?.id ?? data.id)} byla přijata. Termín zatím není rezervován a platba neproběhla.</p><button data-dialog-close>Zavřít</button>`;dialog.querySelector('button').onclick=()=>dialog.close();}catch(error){dialog.querySelector('.live-error').textContent=error.message;}finally{button.disabled=false;}});
}
function configuration(price) {
  const configuration = price?.service_spec ?? spec;
  return `<dl class="live-dl"><dt>Služba</dt><dd>${labels[configuration.service_id]}</dd><dt>Vozidlo</dt><dd>${labels[configuration.vehicle_type]}</dd><dt>Průměr disku</dt><dd>${esc(configuration.wheel_size_inches)}″</dd><dt>Disky</dt><dd>${labels[configuration.rim_type]}</dd><dt>Runflat / TPMS</dt><dd>${configuration.runflat?'Ano':'Ne'} / ${configuration.tpms?'Ano':'Ne'}</dd><dt>Počet kol</dt><dd>4 · vlastní pneumatiky</dd></dl>`;
}
function priceBlock(price) {
  if (!price) return '<p role="status">Načítání kalkulace…</p>';
  return `<p class="kicker mute">Celkem za 4 kola</p><p class="live-total">${money(price.total_minor)}</p><ul class="live-lines">${price.line_items.map(line=>`<li><span>${labels[line.label]??esc(line.label)}</span><span>${money(line.amount_minor)}</span></li>`).join('')}</ul><p class="live-hint">Konečná cena služby v Kč. Testovací síťová transakce se eviduje samostatně.</p>`;
}
function paymentSKU(paymentMode, amountMinor) {
  return (config?.skus ?? config?.available_skus ?? []).find(sku => sku.payment_mode === paymentMode && sku.amount_minor === amountMinor && sku.registered !== false);
}
const checkoutNetworkFee = () => config?.checkout_network_fee ?? '2000000';
function networkFeeLabel() {
  const fee = BigInt(checkoutNetworkFee());
  const whole = new Intl.NumberFormat('cs-CZ').format(fee / 1000000n);
  const fraction = String(fee % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? ',' + fraction : ''} ${config?.network === 'Preprod' ? 'test-ADA' : 'simulovaných ADA'}`;
}
function paymentEnvironment(paymentMode, amountMinor) {
  if (!config) return '<p>Konfigurace plateb není dostupná.</p>';
  const sku=paymentMode ? paymentSKU(paymentMode,amountMinor) : null;
  const ready=config.configured && config.purchase_ready !== false;
  return `<div class="live-notice"><strong>${config.simulation || config.provider === 'local_demo' ? 'Lokální simulace · bez on-chain transakce' : `Masumi · Cardano ${esc(config.network)}`}</strong><p>Testovací platba, bez skutečné autoservisní služby. Cena v Kč není skutečná korunová platba. Escrow se eviduje odděleně od výplaty prodejci.</p>${!ready?`<p class="live-error">Nákup není připraven: ${esc(config.reason ?? 'Chybí konfigurace plateb.')}</p>`:''}${sku?`<p><strong>Síťová částka nyní: ${new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:6}).format(Number(sku.asset_quantity)/1000000)} ${config.simulation?'simulovaných ADA':'test-ADA'}</strong></p><p>Mapování: ${esc(config.mapping_version)}. SKU: ${esc(sku.sku)}. Maximální rozpočet síťového poplatku: ${networkFeeLabel()}. Jde o schválený limit, ne skutečný poplatek.</p>`:paymentMode?'<p class="live-error">Pro tuto částku není registrované platební SKU. Zvolte podporovaný režim nebo požádejte o revizi nabídky.</p>':''}</div><details><summary>Technické podmínky testovací platby</summary>${showJSON(config)}<p class="live-hint">Backend při autorizaci ověří přesnou nabídku, SKU, režim a schválený limit ${esc(checkoutNetworkFee())} lovelace.</p></details>`;
}
function stripeEnvironment(amountMinor) {
  return `<div class="live-notice"><strong>Link / karta · Stripe testovací režim</strong><p>Testovací částka ${money(amountMinor)}. Nejde o skutečnou platbu ani skutečnou autoservisní službu. Platební údaje zadáte na zabezpečené stránce Stripe.</p>${config?.stripe_link?.ready ? '' : '<p class="live-error">Platba přes Link je nyní nedostupná. Můžete zvolit druhou platební metodu.</p>'}</div>`;
}
async function startLinkCheckout(id, paymentMode) {
  const data = await api(`/api/orders/${encodeURIComponent(id)}/link-checkout`, {method:'POST',body:{payment_mode:paymentMode,confirm:true}});
  const checkout = data.stripe_checkout;
  if (checkout?.state === 'paid') { location.assign(`/objednavka/${encodeURIComponent(id)}`); return; }
  const url = new URL(checkout?.checkout_url ?? '');
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) throw new Error('Bezpečný odkaz na Stripe není dostupný. Ověřte existující objednávku.');
  location.assign(url.href);
}
async function checkout() {
  const root=document.getElementById('live-checkout');if(!root)return;
  root.innerHTML='<p role="status">Načítání…</p>';
  try {
    if (!config) config=await api('/api/payments/config');
    if (orderId) {orderData=await api(`/api/orders/${encodeURIComponent(orderId)}`);if(orderData.stripe_checkout && new URLSearchParams(location.search).get('link') === 'return') orderData=await api(`/api/orders/${encodeURIComponent(orderId)}/link-payment`);renderOrder(root);return;}
    if (!quote) {const data=await api('/api/pricing/calculate',{method:'POST',body:{service_spec:spec}});quote=data.price??data;}
    if (!slots.length) slots=list(await api(`/api/availability?service_id=${encodeURIComponent(spec.service_id)}`),'slots');
    renderCheckout(root);
  } catch(error){root.innerHTML=`<h1 class="live-title">Objednání služby</h1><p class="live-error" role="alert">${esc(error.message)}</p><div class="live-actions"><button class="btn btn-green" data-live-retry>Zkusit znovu</button>${[401,403].includes(error.status)?'<button class="btn btn-outline" data-live-login>Přihlásit se</button>':''}</div>`;}
}
function renderCheckout(root) {
  const titles=['Konfigurace','Kontakt a termín','Souhrn a autorizace'];
  const slot=slots.find(slot=>slot.id===selectedSlot);
  const now=mode==='deposit'?Math.min(50000,quote.total_minor):quote.total_minor;
  const isStripe=checkoutProvider==='stripe';
  const fullAvailable=isStripe || Boolean(paymentSKU('full',quote.total_minor));const depositAvailable=isStripe || Boolean(paymentSKU('deposit',Math.min(50000,quote.total_minor)));const selectedSKU=isStripe || paymentSKU(mode,now);
  const paymentReady=isStripe ? config.stripe_link?.ready : config.configured && config.purchase_ready!==false;
  let body;
  if(stage===1) body=`<section class="live-section"><h2 class="live-subtitle">Konfigurace z kalkulátoru</h2>${configuration(quote)}<p class="live-hint">Uskladnění, prodej pneumatik a dílů nejsou součástí služby.</p><div class="live-actions"><a class="btn btn-outline" href="/kalkulator">Upravit konfiguraci</a><button class="btn btn-green" data-live-next>Pokračovat na kontakt a termín</button></div></section>`;
  if(stage===2) body=`<form class="live-form live-section" id="live-contact"><h2 class="live-subtitle">Kontakt a termín</h2><label>Jméno a příjmení<input name="name" autocomplete="name" value="${esc(contact.name)}"></label><label>E-mail<input name="email" type="email" autocomplete="email" value="${esc(contact.email)}" required></label><label>Telefon<input name="phone" type="tel" autocomplete="tel" value="${esc(contact.phone)}" required></label><fieldset style="border:0;padding:0"><legend class="lbl">Volný termín · Europe/Prague</legend>${slots.length?slots.map(slot=>`<label class="live-slot"><input type="radio" name="slot_id" value="${esc(slot.id)}" ${slot.id===selectedSlot?'checked':''} required>${slotDate(slot)} – ${slotEnd(slot)} · ${esc(slot.resource_id??slot.bay_id??'Servisní box')}</label>`).join(''):'<p>Momentálně není volný termín. Odešlete nezávaznou poptávku.</p>'}</fieldset><p class="live-hint">Výběr termínu jej zatím neblokuje. Dostupnost se znovu ověří při nákupu.</p><div class="live-actions"><button class="btn btn-outline" type="button" data-live-back>Zpět</button><button class="btn btn-green" type="submit" ${slots.length?'':'disabled'}>Zobrazit souhrn</button></div></form>`;
  if(stage===3) body=`<form id="live-authorize" class="live-form live-section"><h2 class="live-subtitle">Souhrn objednávky</h2>${configuration(quote)}<fieldset class="live-payment-methods"><legend class="lbl">Platební metoda</legend><label class="live-slot"><input type="radio" name="checkout_provider" value="masumi" ${isStripe?'':'checked'}>${config.simulation?'Lokální testovací platba':'Masumi · test-ADA v escrow'}</label><label class="live-slot"><input type="radio" name="checkout_provider" value="stripe" ${isStripe?'checked':''} ${config.stripe_link?.ready?'':'disabled'}>Link / karta · testovací platba v Kč</label></fieldset><p><strong>Termín:</strong> ${slotDate(slot)} – ${slotEnd(slot)}</p><p>${esc(contact.name)} · ${esc(contact.email)} · ${esc(contact.phone)}</p><fieldset style="border:0;padding:0"><legend class="lbl">Režim úhrady</legend><label class="live-slot"><input type="radio" name="payment_mode" value="deposit" ${mode==='deposit'?'checked':''} ${depositAvailable?'':'disabled'}>Záloha ${money(Math.min(50000,quote.total_minor))}</label><label class="live-slot"><input type="radio" name="payment_mode" value="full" ${mode==='full'?'checked':''} ${fullAvailable?'':'disabled'}>Plná úhrada ${money(quote.total_minor)} ${fullAvailable?'':'· SKU není dostupné'}</label></fieldset><dl class="live-dl"><dt>Částka nyní</dt><dd>${money(now)}</dd><dt>Doplatek po záloze</dt><dd>${money(quote.total_minor-now)}</dd></dl>${isStripe?stripeEnvironment(now):paymentEnvironment(mode,now)}${!actor?'<p>Pro závazný nákup se přihlaste zákaznickým účtem.</p><button class="btn btn-outline" type="button" data-live-login>Přihlásit se</button>':actor.role!=='human_customer'?'<p class="live-error">Tento účet není zákaznický. Nákup vyžaduje vlastní zákaznický účet.</p>':''}<label style="display:block"><input type="checkbox" name="confirm" required> ${isStripe?`Výslovně schvaluji testovací platbu ${money(now)} přes Stripe.`:`Výslovně autorizuji tento testovací nákup v uvedeném režimu a akceptuji maximální síťový rozpočet ${networkFeeLabel()}.`}</label><div class="live-actions"><button class="btn btn-outline" type="button" data-live-back>Zpět</button><button class="btn ${isStripe?'btn-link-pay':'btn-green'}" type="submit" ${busy||!actor||actor.role!=='human_customer'||!paymentReady||!selectedSKU?'disabled':''}>${busy?'Zpracování…':isStripe?'Zaplatit přes Link / kartou':'Autorizovat a koupit službu'}</button></div></form>`;
  root.innerHTML=`<p class="kicker" style="color:var(--goldd)">Objednání služby · krok ${stage} ze 3</p><h1 class="live-title">${titles[stage-1]}</h1><ol class="steps">${titles.map((title,i)=>`<li class="stp ${i+1===stage?'on':i+1<stage?'done':''}" aria-current="${i+1===stage?'step':'false'}"><b>${i+1}</b>${title}</li>`).join('')}</ol>${pageError?`<p class="live-error" role="alert">${esc(pageError)}</p>`:''}<div class="live-grid" style="margin-top:28px"><div>${body}</div><aside class="card pad live-stack">${priceBlock(quote)}</aside></div>`;
  root.querySelector('#live-contact')?.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));contact={name:data.name,email:data.email,phone:data.phone};selectedSlot=data.slot_id;stage=3;renderCheckout(root);});
  root.querySelectorAll('[name=checkout_provider]').forEach(input=>input.addEventListener('change',()=>{checkoutProvider=input.value;renderCheckout(root);}));
  root.querySelectorAll('[name=payment_mode]').forEach(input=>input.addEventListener('change',()=>{mode=input.value;renderCheckout(root);}));
  root.querySelector('#live-authorize')?.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;pageError='';renderCheckout(root);try{const data=await api('/api/orders',{method:'POST',body:{service_spec:spec,slot_id:selectedSlot,...contact}});const id=data.order.id;if(isStripe){try{await startLinkCheckout(id,mode);}catch(error){sessionStorage.setItem(`pneu007-order-error-${id}`,error.message);location.assign(`/objednavka/${encodeURIComponent(id)}`);}return;}try{await api(`/api/orders/${encodeURIComponent(id)}/checkout`,{method:'POST',body:{payment_mode:mode,confirm:true,max_network_fee:checkoutNetworkFee()}});}catch(error){sessionStorage.setItem(`pneu007-order-error-${id}`,error.message);}location.assign(`/objednavka/${encodeURIComponent(id)}`);}catch(error){pageError=error.message;busy=false;renderCheckout(root);}});
}
function renderOrder(root) {
  if(orderData.stripe_checkout){renderStripeOrder(root);return;}
  const {order,booking}=orderData;const price=orderData.quote?.price??orderData.quote??quote;const payment=orderData.payment??orderData.intent;const observation=payment?.observation;const state=payment?.state??observation?.state;
  const paidStates=['escrow_funded','result_submitted'];const paid=paidStates.includes(state);const balance=order.balance_minor??price?.total_minor;
  const isSimulation=config.simulation||config.provider==='local_demo';
  const storedError=sessionStorage.getItem(`pneu007-order-error-${order.id}`);
  root.innerHTML=`<p class="kicker" style="color:var(--goldd)">Objednávka ${esc(order.id)}</p><h1 class="live-title">Stav objednávky</h1>${storedError?`<p class="live-error" role="alert">${esc(storedError)}</p>`:''}<div class="live-grid"><div class="live-stack"><section class="live-section"><h2 class="live-subtitle">Služba a rezervace</h2>${configuration(price)}${orderData.contact ? `<h3>Uložený kontakt</h3><p>${esc(orderData.contact.name || 'Jméno neuvedeno')}<br>${esc(orderData.contact.email)}<br>${esc(orderData.contact.phone)}</p>` : ''}<dl class="live-dl" style="margin-top:20px"><dt>Objednávka</dt><dd>${esc(order.status)}</dd><dt>Rezervace</dt><dd>${esc(booking?.status??'Dosud nepotvrzena')}</dd><dt>Fyzická služba</dt><dd>${order.service_status==='completed'||order.status==='service_completed'?'Provedena':'Dosud neprovedena'}</dd><dt>Doplatek v Kč</dt><dd>${money(balance)}</dd></dl>${booking?'<div class="live-actions"><a class="btn btn-outline" href="/api/orders/'+encodeURIComponent(order.id)+'/confirmation.ics">Stáhnout do kalendáře</a></div>':''}<p class="live-hint">Potvrzená rezervace neznamená provedené přezutí.</p></section><section class="live-section"><h2 class="live-subtitle">Platba</h2><p><strong>${paymentLabels[state]??'Nákup ještě nebyl autorizován'}</strong></p>${paymentEnvironment(payment?.payment_mode,payment?.amount_minor)}<dl class="live-dl"><dt>Prostředky v escrow</dt><dd>${paid?money(payment.amount_minor)+' · obchodní ekvivalent':state==='seller_paid'?'Vyplaceno prodejci':state==='refunded'?'Vráceno zákazníkovi':'Dosud neověřeny'}</dd><dt>Výplata prodejci</dt><dd>${state==='seller_paid'?'Ověřena':'Dosud neověřena'}</dd><dt>Síťová částka</dt><dd>${esc(payment?.asset_quantity??'—')} ${esc(payment?.asset??'')}</dd></dl><div class="live-actions"><button class="btn btn-green" data-live-refresh ${busy?'disabled':''}>${busy?'Ověřování…':'Ověřit aktuální stav'}</button>${!payment?'<button class="btn btn-outline" data-live-existing-checkout>Koupit službu</button>':''}${!payment && config.stripe_link?.ready?'<button class="btn btn-link-pay" data-live-link-checkout>Zaplatit zálohu přes Link</button>':''}</div><p class="live-hint">Nejasný stav vyžaduje kontrolu; platbu znovu nespouštějte naslepo.</p><details><summary>Technické detaily platby</summary>${showJSON(payment??{})}${observation?.transaction_hash&&!isSimulation?`<p>On-chain hash: ${esc(observation.transaction_hash)}</p>`:''}${isSimulation?'<p>Lokální simulace neobsahuje skutečný blockchainový hash.</p>':''}</details></section></div><aside class="card pad live-stack">${priceBlock(price)}<details><summary>Uložená objednávka a rezervace</summary>${showJSON(orderData)}</details></aside></div>`;
}
function renderStripeOrder(root) {
  const {order,booking,stripe_checkout:payment}=orderData;
  const price=orderData.quote.price;
  const labels={prepared:'Platba připravena',creating:'Připravuje se zabezpečený checkout',open:'Čeká na dokončení platby ve Stripe',processing:'Stripe platbu zpracovává',paid:'Testovací platba ověřena',expired:'Platnost platebního odkazu skončila',reconciliation_required:'Platba vyžaduje kontrolu',failed:'Testovací platba nebyla úspěšná'};
  const canContinue=payment.state==='open' && payment.checkout_url;
  let paymentURL;
  try{const url=new URL(payment.checkout_url);if(url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.username&&!url.password)paymentURL=url.href;}catch{}
  root.innerHTML=`<p class="kicker" style="color:var(--goldd)">Objednávka ${esc(order.id)}</p><h1 class="live-title">Platba přes Link / kartou</h1><div class="live-grid"><section class="live-section live-stack"><h2 class="live-subtitle">${labels[payment.state]??'Ověřování platby'}</h2>${stripeEnvironment(payment.amount_minor)}<dl class="live-dl"><dt>Testovací platba</dt><dd>${money(payment.amount_minor)}</dd><dt>Rezervace</dt><dd>${esc(booking?.status??'Dosud nepotvrzena')}</dd><dt>Doplatek</dt><dd>${money(order.balance_minor)}</dd></dl>${payment.state==='paid'?'<p>Stripe potvrdil přijetí testovací platby. Tento stav neznamená převod na bankovní účet. Fyzická služba zůstává fiktivní.</p>':'<p>Rezervaci potvrdíme až po ověření platby přímo u Stripe. Návrat z platební stránky sám o sobě platbu nepotvrzuje.</p>'}<div class="live-actions">${canContinue&&paymentURL?`<a class="btn btn-link-pay" href="${esc(paymentURL)}">Pokračovat v Link / kartou</a>`:''}<button class="btn btn-green" data-live-refresh ${busy?'disabled':''}>${busy?'Ověřování…':'Ověřit aktuální stav'}</button>${booking?`<a class="btn btn-outline" href="/api/orders/${encodeURIComponent(order.id)}/confirmation.ics">Stáhnout do kalendáře</a>`:''}</div></section><aside class="card pad live-stack">${priceBlock(price)}${configuration(price)}</aside></div>`;
}
async function refreshPayment() {
  if(busy)return;busy=true;renderOrder(document.getElementById('live-checkout'));
  try{await api(`/api/orders/${encodeURIComponent(orderId)}/${orderData.stripe_checkout?'link-payment':'payment'}`);orderData=await api(`/api/orders/${encodeURIComponent(orderId)}`);sessionStorage.removeItem(`pneu007-order-error-${orderId}`);}catch(error){notice(error.message);}finally{busy=false;renderOrder(document.getElementById('live-checkout'));}
}
document.addEventListener('click',async event=>{
  if(event.target.closest('[data-live-login]'))login();
  if(event.target.closest('[data-live-logout]')){await api('/api/logout',{method:'POST',body:{}});await refreshSession();if(document.getElementById('live-checkout'))await checkout();}
  if(event.target.closest('[data-live-inquiry]'))inquiry();
  if(event.target.closest('[data-live-next]')){stage=2;renderCheckout(document.getElementById('live-checkout'));}
  if(event.target.closest('[data-live-back]')){stage=Math.max(1,stage-1);renderCheckout(document.getElementById('live-checkout'));}
  if(event.target.closest('[data-live-retry]'))await checkout();
  if(event.target.closest('[data-live-refresh]'))await refreshPayment();
  if(event.target.closest('[data-live-link-checkout]')){
    const dialog=modal('Zaplatit zálohu přes Link',`<p>Testovací záloha 500 Kč. Platební údaje zadáte na zabezpečené stránce Stripe. Nejde o skutečnou úhradu.</p><form><label><input type="checkbox" required> Výslovně schvaluji testovací platbu zálohy 500 Kč.</label><p class="live-error" role="alert"></p><div class="live-actions"><button type="submit">Pokračovat do Link / kartou</button><button type="button" data-dialog-close>Zavřít</button></div></form>`);
    dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{await startLinkCheckout(orderId,'deposit');}catch(error){dialog.querySelector('.live-error').textContent=error.message;}finally{button.disabled=false;}};
  }
  if(event.target.closest('[data-live-existing-checkout]')){
    const dialog=modal('Autorizace nákupu',`<p>Záloha je částí celkové ceny ${money(orderData.quote.price.total_minor)}.</p><form><label>Režim<select name="payment_mode"><option value="deposit" ${paymentSKU('deposit',50000)?'':'disabled'}>Záloha 500 Kč</option><option value="full" ${paymentSKU('full',orderData.quote.price.total_minor)?'':'disabled'}>Plná úhrada</option></select></label><p>Testovací platba bez skutečné služby. Maximální rozpočet síťového poplatku ${networkFeeLabel()}. Jde o schválený limit, ne skutečný poplatek.</p><label><input type="checkbox" required> Výslovně autorizuji nákup a maximální síťový rozpočet ${networkFeeLabel()}.</label><p class="live-error" role="alert"></p><div class="live-actions"><button type="submit">Autorizovat a koupit</button><button type="button" data-dialog-close>Zavřít</button></div></form>`);dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await api(`/api/orders/${encodeURIComponent(orderId)}/checkout`,{method:'POST',body:{payment_mode:new FormData(e.target).get('payment_mode'),confirm:true,max_network_fee:checkoutNetworkFee()}});dialog.close();await checkout();}catch(error){dialog.querySelector('.live-error').textContent=error.message;}finally{button.disabled=false;}};
  }
});
async function initialize() {
  const nav=document.querySelector('header[data-dc-tpl]');if(!nav)return false;
  await refreshSession().catch(()=>{});
  const profile=location.pathname==='/pro-agenty'?await api('/api/agent/profile').catch(()=>null):null;
  if(location.pathname.startsWith('/objednavka'))await checkout();
  if(location.pathname==='/pro-agenty'){
    const detail=document.querySelector('.tech .tb');
    if(profile&&detail){
      const card=profile.active&&profile.transport_configured?await api('/.well-known/agent-card.json').catch(()=>null):null;
      detail.textContent=JSON.stringify(card ?? profile,null,2);
      const panel=document.createElement('section');panel.className='live-section';
      panel.innerHTML=`<h2 class="live-subtitle">Aktuální stav rozhraní</h2><p><strong>${profile.active?'Aktivní auditovaný rulebook':'Agent zatím není aktivní'}</strong></p><p>${profile.active?'Majitel aktivoval aktuální návrh pravidel.':'Autonomní obchodování čeká na audit zdrojů a lidskou aktivaci rulebooku. Lidské objednání funguje samostatně.'}</p><p>Transport: ${profile.transport_configured?'Nakonfigurován; kompatibilitu dokládá samostatný test.':'Dosud nenakonfigurován.'}</p><p>Platby: ${profile.payment?.simulation?'Lokální simulace, bez on-chain transakce.':esc(profile.payment?.network ?? 'Stav není dostupný.')}</p>${card?'<a href="/.well-known/agent-card.json">Otevřít publikovaný Agent Card</a>':''}`;
      document.querySelector('[aria-labelledby="ac-h"]').prepend(panel);
      const note=detail.closest('section').querySelector('p.small.mute');if(note)note.textContent='Technický detail zobrazuje aktuální serverový stav. Agent Card neobsahuje interní pravidla, soukromá data ani klíče.';
    }
  }
  return true;
}
// DC renders the supplied template after DOMContentLoaded; wait for its actual content.
if(!await initialize()){
  const observer=new MutationObserver(()=>{if(document.querySelector('header[data-dc-tpl]')){observer.disconnect();initialize();}});observer.observe(document.body,{childList:true,subtree:true});
}
