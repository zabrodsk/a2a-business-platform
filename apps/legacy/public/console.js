import { api, list, escapeHTML as esc, date } from './api.js';
const main = document.querySelector('main');
const handoru = location.pathname.startsWith('/handle') || location.pathname.startsWith('/handoru');
const agentClaim = location.pathname === '/agent/claim';
const agentAccess = location.pathname === '/agent/access';
const agentMandates = location.pathname === '/agent/mandates';
const customerPage = agentClaim || agentAccess || agentMandates;
if (customerPage) document.querySelectorAll('footer a[href="/admin"], footer a[href="/handle"], footer a[href="/handoru"]').forEach(link => link.remove());
const mandateId = new URLSearchParams(location.search).get('mandate_id');
const claimAttempt = new URLSearchParams(location.search).get('claim_attempt_token');
let actor, selected = handoru ? 'sources' : 'overview';
const adminTabs = { overview: 'Přehled', orders: 'Objednávky', calendar: 'Kalendář', customers: 'Zákazníci', inventory: 'Sklad', partners: 'Dodavatelé' };
const handoruTabs = { sources: 'Zdroje a audit', rulebooks: 'Rulebook', approvals: 'Schválení', mandates: 'Mandáty', events: 'Události', profile: 'Veřejný profil' };
function json(data) { return `<pre>${esc(JSON.stringify(data, null, 2))}</pre>`; }
function feedback(message) { const toast = document.getElementById('toast'); toast.textContent = message; toast.style.display = 'block'; setTimeout(() => toast.style.display = 'none', 5000); }
function action(label, action, id) { return `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`; }
function contactSummary(contact) { return contact ? `<section><h4>Uložený kontakt</h4><p>${esc(contact.name || 'Jméno neuvedeno')}<br>${esc(contact.email)}<br>${esc(contact.phone)}</p></section>` : ''; }
function ownerPaymentActions(record) {
  if (actor?.role !== 'owner') return '';
  const intent = record.intent ?? record.payment, order = record.order ?? record;
  if (!intent) return '';
  let buttons = '';
  if (intent.provider === 'masumi' && ['purchase_requested', 'reconciliation_required'].includes(intent.state) && !['cancel_requested','cancelled','refund_pending','refunded'].includes(order.status)) buttons += action('Prověřit a obnovit zahájený nákup', 'resume-payment', order.id);
  if (intent.provider === 'masumi' && intent.observation?.state === 'refund_requested') buttons += action('Autorizovat ověřenou žádost o refund', 'authorize-refund', order.id);
  if (['escrow_funded','result_submitted'].includes(intent.observation?.state) && !['refund_requested','refunded'].includes(intent.state)) buttons += action('Požádat o refund a stornovat', 'refund-request', order.id);
  return buttons;
}
function detail(record) { return `<details><summary>Podklad a technický detail</summary>${json(record)}</details>`; }
function rows(records, kind) {
  if (!records.length) return '<p>Žádné záznamy. Zatím zde není dokončený audit ani vytvořené rozhodnutí.</p>';
  return records.map(record => {
    const id = record.id ?? record.source_id ?? record.version;
    let actions = '';
    if (kind === 'orders') actions = `${action('Otevřít objednávku', 'order-detail', id)} ` + `${action('Změnit termín', 'reschedule', id)} ${action('Stornovat', 'cancel', id)}` + ownerPaymentActions(record);
    if (kind === 'rulebooks' && record.status === 'proposed' && actor?.role === 'owner') actions = action('Schválit a aktivovat verzi', 'activate', record.version);
    if (kind === 'approvals' && ['pending','requested'].includes(record.status)) actions = `${action('Schválit', 'approve', id)} ${action('Zamítnout', 'reject', id)}`;
    if (kind === 'mandates' && record.status !== 'approved' && actor?.role === 'human_customer') actions = action('Schválit mandát', 'mandate', id);
    if (kind === 'sources') actions = `<a class="button secondary" href="/api/audit/export/${encodeURIComponent(record.id ?? record.source_id)}" target="_blank" rel="noopener">Otevřít zdroj</a>`;
    return `<article class="card"><h3>${esc(record.name ?? record.title ?? record.id ?? record.source_id ?? `Verze ${record.version}`)}</h3><p><span class="status">${esc(record.status ?? record.access ?? record.visibility ?? record.state ?? 'Demo záznam')}</span> ${record.start_at ? date(record.start_at) : record.start ? date(record.start) : ''}</p>${record.authority ? `<p>Autorita: ${esc(record.authority)}</p>` : ''}${record.version ? `<p>Verze: ${esc(record.version)} ${record.current === false ? '· archivní / neautoritativní podklad' : ''}</p>` : ''}${record.evidence ? `<h4>Pravidla a jejich podklady</h4>${Object.entries(record.evidence).map(([key,citations])=>`<div class="grid card"><div><h4>${esc(key)}</h4>${json(record.params?.[key])}</div><div>${citations.map(citation=>`<p><a href="/api/audit/export/${encodeURIComponent(citation.source_id)}" target="_blank" rel="noopener">${esc(citation.source_id)} · ${esc(citation.version)}</a></p><blockquote>${esc(citation.excerpt)}</blockquote>`).join('')}</div></div>`).join('')}` : ''}${kind === 'orders' ? contactSummary(record.contact) : ''}${kind === 'orders' && (record.intent ?? record.payment)?.observation?.state === 'seller_paid' ? '<p class="notice">Prostředky již byly vyplaceny. Případné vrácení vyžaduje samostatnou kompenzaci majitelem.</p>' : ''}${detail(record)}<div class="actions">${actions}</div></article>`;
  }).join('');
}
async function session() {
  const data = await api('/api/session'); actor = data.actor;
  document.getElementById('session').innerHTML = actor ? `<span>${customerPage ? actor.role === 'human_customer' ? 'Zákaznický účet' : 'Přihlášený účet' : `${esc(actor.id)} · ${esc(actor.role)}`}</span> ${actor.role === 'human_customer' ? '<a href="/agent/access">Přístupy agentů</a> ' : ''}${action('Odhlásit', 'logout', '')}` : action('Přihlásit se','login','');
}
async function renderAgentAccess() {
  main.innerHTML = `<p class="eyebrow">Pneu 007 · přístupy agentů</p><h1>${agentClaim ? 'Propojit vašeho agenta' : 'Vaši propojení agenti'}</h1><section id="content" aria-live="polite"><p role="status">Načítání…</p></section>`;
  const content = document.getElementById('content');
  if (!actor) {
    content.innerHTML = '<article class="card"><h2>Přihlaste se jako zákazník</h2><p>Po přihlášení můžete propojit svého agenta nebo odebrat jeho přístup.</p><button data-action="login">Přihlásit se</button></article>';
    return;
  }
  if (actor.role !== 'human_customer') {
    content.innerHTML = '<article class="card"><p class="error" role="alert">Propojení může potvrdit pouze přihlášený zákazník.</p><button data-action="logout">Odhlásit se</button></article>';
    return;
  }
  try {
    if (agentClaim) {
      if (!claimAttempt) throw new Error('Chybí odkaz pro propojení. Požádejte svého agenta o nový.');
      const request = await api(`/api/agent/identity/claim-request?claim_attempt_token=${encodeURIComponent(claimAttempt)}`);
      content.innerHTML = `<article class="card"><h2>Potvrdit přístup agenta</h2><p>Agent <strong class="agent-id">${esc(request.registration_id)}</strong> žádá o přístup k vašim poptávkám a nabídkám. Rezervace a platba nadále vyžadují vámi schválený mandát.</p><p>Pokračujte pouze, pokud jste tohoto agenta sami požádali o propojení. Ověřte, že vám ukázal stejnou identitu.</p><p>Platnost kódu do ${date(request.expires_at)}.</p><form id="agent-claim-form"><label>Šestimístný kód od vašeho agenta<input name="user_code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><p class="error" role="alert" id="claim-error"></p><div class="actions"><button type="submit">Propojit agenta</button><a class="button secondary" href="/agent/access">Zrušit</a></div></form></article>`;
      return;
    }
    const data = await api('/api/agent/identities');
    const identities = list(data, 'identities');
    const statuses = {claimed:'Propojený',unclaimed:'Čeká na propojení',revoked:'Přístup odebrán',expired:'Platnost vypršela'};
    content.innerHTML = '<p>Zde můžete odebrat přístup agentům, které jste propojili se svým účtem.</p>' + (identities.length ? identities.map(identity => `<article class="card"><h2 class="agent-id">${esc(identity.agent_id)}</h2><p>Stav: ${esc(statuses[identity.status] ?? identity.status)} · platnost do ${date(identity.expires_at)}</p>${identity.status === 'claimed' ? action('Odebrat přístup', 'revoke-agent', identity.registration_id) : ''}</article>`).join('') : '<article class="card"><p>Zatím nemáte propojeného žádného agenta.</p></article>');
  } catch (error) {
    content.innerHTML = `<article class="card"><p class="error" role="alert">${esc(error.message)}</p><p>Pokud odkaz vypršel, požádejte agenta o nový kód. Propojení potvrďte účtem, pro který bylo vyžádáno.</p></article>`;
  }
}
function moneyLimit(value) {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK' }).format(value / 100);
}
function assetLimit(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return 'Neuvedeno';
  const units = BigInt(value), fraction = (units % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${units / 1000000n}${fraction ? `,${fraction}` : ''} test ADA (${value} lovelace)`;
}
async function renderCustomerMandate() {
  main.innerHTML = '<p class="eyebrow">Pneu 007 · souhlas zákazníka</p><h1>Oprávnění vašeho agenta</h1><section id="content" aria-live="polite"><p role="status">Načítání…</p></section>';
  const content = document.getElementById('content');
  if (!actor) {
    content.innerHTML = '<article class="card"><h2>Přihlaste se jako zákazník</h2><p>Pro kontrolu a schválení oprávnění použijte účet, který jste propojili se svým agentem. Samotné propojení agenta není souhlasem s rezervací ani platbou.</p><button data-action="login">Přihlásit se</button></article>';
    return;
  }
  if (actor.role !== 'human_customer') {
    content.innerHTML = '<article class="card"><p class="error" role="alert">Toto oprávnění může schválit pouze zákazník ze svého účtu.</p><button data-action="logout">Odhlásit se</button></article>';
    return;
  }
  if (!mandateId) {
    content.innerHTML = '<article class="card"><p class="error" role="alert">Chybí odkaz na konkrétní oprávnění. Požádejte svého agenta o schvalovací odkaz.</p></article>';
    return;
  }
  try {
    const data = await api('/api/admin/mandates');
    const mandate = list(data, 'mandates').find(value => value.id === mandateId);
    if (!mandate) {
      content.innerHTML = '<article class="card"><p class="error" role="alert">Oprávnění nebylo nalezeno pro váš účet. Zkontrolujte účet a požádejte svého agenta o správný odkaz.</p></article>';
      return;
    }
    const spec = mandate.service_spec;
    const service = {tyre_change:'Přezutí pneumatik',wheel_swap:'Výměna kompletních kol'}[spec.service_id] ?? spec.service_id;
    const vehicle = {personal:'osobní vůz',suv:'SUV',van:'dodávka'}[spec.vehicle_type] ?? spec.vehicle_type;
    const expiry = Date.parse(mandate.expires_at);
    const expired = !Number.isFinite(expiry) || expiry <= Date.now();
    const approved = mandate.status === 'approved';
    const recommend = mandate.mode === 'recommend';
    const status = expired ? 'Platnost vypršela' : approved ? 'Schváleno' : 'Čeká na váš souhlas';
    content.innerHTML = `<article class="card mandate-summary"><h2>${esc(service)}</h2><p><span class="status">${status}</span></p><p>Samotné propojení agenta není souhlasem s rezervací ani platbou. Zde schvalujete konkrétní rozsah jeho oprávnění.</p><dl class="mandate-details">
      <dt>Služba a vozidlo</dt><dd>${esc(spec.wheel_count)} kola · ${esc(vehicle)} · ${esc(spec.wheel_size_inches)}″ · ${spec.rim_type === 'alu' ? 'hliníkové disky' : 'ocelové disky'} · runflat ${spec.runflat ? 'ano' : 'ne'} · TPMS ${spec.tpms ? 'ano' : 'ne'}</dd>
      <dt>Co smí agent udělat</dt><dd>${recommend ? 'Pouze doporučit nabídku. Nesmí vytvořit rezervaci ani provést platbu.' : 'Přijmout nabídku, rezervovat službu a zahájit testovací platbu v níže uvedených mezích.'}</dd>
      <dt>Celkový cenový limit služby</dt><dd>${esc(moneyLimit(mandate.max_total_minor))}</dd>
      <dt>Limit zálohy</dt><dd>${esc(moneyLimit(mandate.max_deposit_minor))}</dd>
      <dt>Způsob platby</dt><dd>${mandate.payment_mode === 'deposit' ? 'Pouze záloha' : 'Celá částka'}</dd>
      <dt>Termín</dt><dd>Dokončení nejpozději ${date(mandate.latest_service_end)} (Praha). Toto oprávnění neurčuje přesný čas rezervace; agent jej dohodne v této lhůtě.</dd>
      <dt>Platnost oprávnění</dt><dd>Do ${date(mandate.expires_at)} (Praha)</dd>
      <dt>Testovací síť</dt><dd>${mandate.network === 'Preprod' ? 'Cardano Preprod · testovací prostředky' : 'Místní simulace · bez on-chain platby'}</dd>
      <dt>Limit testovací platby</dt><dd>${esc(assetLimit(mandate.max_asset_quantity))}</dd>
      <dt>Limit síťového poplatku</dt><dd>${esc(assetLimit(mandate.max_network_fee))} navíc k platbě</dd>
      <dt>Příjemce</dt><dd>${esc(mandate.seller_id)}</dd>
      <dt>Cenový převod</dt><dd>${esc(mandate.mapping_version)} · korunová cena a testovací ADA jsou oddělené limity.</dd>
      <dt>Další služby</dt><dd>Žádné služby navíc nejsou povoleny.</dd>
      <dt>Váš agent</dt><dd class="agent-id">${esc(mandate.proposed_by)}</dd>
    </dl>${expired ? '<p class="error" role="alert">Platnost tohoto oprávnění vypršela. Požádejte agenta o nový návrh; tento již nelze použít.</p>' : approved ? '<p class="notice">Váš souhlas je uložen. Vraťte se ke svému agentovi, který může pokračovat v povolených mezích. Schválení samo o sobě nepotvrzuje rezervaci ani dokončenou platbu.</p>' : `<p class="notice">${recommend ? 'Souhlas povoluje pouze doporučení nabídky.' : 'Souhlas dovoluje agentovi pokračovat s rezervací a testovací platbou bez dalšího schvalování, pokud nepřekročí uvedené limity.'} Tímto tlačítkem se ještě neprovádí platba.</p><p class="error" role="alert" id="mandate-error"></p><div class="actions">${action(recommend ? 'Schválit pouze doporučení' : 'Schválit rezervaci a testovací platbu v těchto mezích', 'customer-mandate', mandate.id)}</div>`}</article>`;
  } catch (error) {
    content.innerHTML = `<article class="card"><p class="error" role="alert">${esc(error.message)}</p><button data-action="reload">Zkusit znovu</button></article>`;
  }
}
async function render() {
  if (agentMandates) return renderCustomerMandate();
  if (agentClaim || agentAccess) return renderAgentAccess();
  const tabs = handoru ? handoruTabs : adminTabs;
  main.innerHTML = `<p class="eyebrow">${handoru ? 'Handle' : 'Pneu 007 · provoz'}</p><h1>${handoru ? 'Audit a provoz agenta' : 'Administrace'}</h1><nav class="tabs" aria-label="Pracovní pohledy">${Object.entries(tabs).map(([key,label]) => `<button data-tab="${key}" aria-current="${selected === key}">${label}</button>`).join('')}</nav><section id="content" aria-live="polite"><p role="status">Načítání…</p></section>`;
  const content = document.getElementById('content');
  try {
    if (selected === 'profile') { const profile = await api('/api/agent/profile'); content.innerHTML = `<article class="card"><h2>Veřejné rozhraní</h2><p>Publikovaný profil a schopnosti firmy. Kompatibilitu doloží až ověřená komunikace skutečných botů.</p>${json(profile)}</article>`; return; }
    const path = selected === 'sources' ? '/api/audit/sources' : `/api/admin/${selected}`;
    const data = await api(path);
    if (selected === 'overview') { content.innerHTML = `<article class="card"><h2>Provozní přehled</h2><p>Korunové ceny, historická demo data a testnet prostředky se evidují odděleně.</p>${json(data)}</article>`; return; }
    const records = list(data, selected);
    const intro = selected === 'sources' ? '<p>Agent čte skutečné podklady demo businessu. Návrh musí uvést zdroj, verzi, rozpory i neznámé; tato konzole audit automaticky nepředstírá.</p>' : selected === 'rulebooks' ? `<p>${data.active ? `Aktivní rulebook: verze ${esc(data.active.version ?? data.active)}` : 'Zatím není aktivní rulebook.'} Lidské objednání funguje nezávisle. Aktivace podléhá serverové kontrole oprávnění a podkladů.</p>` : '';
    content.innerHTML = intro + rows(records, selected) + (selected === 'calendar' ? '<h2>Dočasné blokace a případy k prověření</h2>' + rows(list(data,'holds'),'holds') : '');
  } catch (error) {
    content.innerHTML = `<div class="card"><p class="error" role="alert">${esc(error.message)}</p>${[401,403].includes(error.status) ? '<p>Přihlaste se účtem s oprávněním k tomuto pohledu.</p><button data-action="login">Přihlásit se</button>' : '<button data-action="reload">Zkusit znovu</button>'}</div>`;
  }
}
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-tab]'); if (tab) { selected = tab.dataset.tab; await render(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action: name, id } = button.dataset;
  if (name === 'login') { document.getElementById('login-dialog').showModal(); return; }
  if (name === 'close-login') { document.getElementById('login-dialog').close(); return; }
  if (name === 'reload') { await render(); return; }
  button.disabled = true;
  try {
    if (name === 'logout') { await api('/api/logout', { method:'POST', body:{} }); await session(); await render(); return; }
    if (name === 'customer-mandate') {
      if (!agentMandates || actor?.role !== 'human_customer' || id !== mandateId) return;
      await api(`/api/admin/mandates/${encodeURIComponent(id)}/approve`, {method:'POST',body:{}});
      await render(); return;
    }
    if (name === 'revoke-agent') {
      if (!confirm('Odebrat tomuto agentovi přístup k vašemu účtu?')) return;
      await api(`/api/agent/identities/${encodeURIComponent(id)}/revoke`, {method:'POST',body:{}});
      feedback('Přístup agenta byl odebrán.'); await render(); return;
    }
    if (name === 'order-detail') {const data=await api(`/api/orders/${encodeURIComponent(id)}`);const dialog=document.createElement('dialog');dialog.innerHTML=`<h2>Objednávka ${esc(id)}</h2>${contactSummary(data.contact)}${json(data)}<button>Zavřít</button>`;document.body.append(dialog);dialog.showModal();dialog.querySelector('button').onclick=()=>{dialog.close();dialog.remove();};return;}
    if (['resume-payment','authorize-refund','refund-request'].includes(name)) {
      const confirmations = {
        'resume-payment': `Prověřit a obnovit zahájený nákup objednávky ${id}? Server ověří existující platbu a bezpečnost obnovení. Potvrzujete pouze tento konkrétní krok.`,
        'authorize-refund': `Autorizovat ověřenou žádost o refund objednávky ${id}? Tímto výslovně potvrzujete tuto konkrétní refund operaci.`,
        'refund-request': `Stornovat objednávku ${id} a požádat o vrácení ověřených prostředků v escrow? Tento krok je žádostí, nikoli potvrzením dokončeného refundu.`
      };
      if (!confirm(confirmations[name])) return;
      await api(`/api/admin/orders/${encodeURIComponent(id)}/${name}`, {method:'POST',body:name === 'refund-request' ? {} : {confirm:true}});
    }
    if (name === 'cancel') { if (!confirm('Stornovat tuto objednávku? Server vyhodnotí rezervaci a případný refund.')) return; await api(`/api/admin/orders/${encodeURIComponent(id)}/cancel`,{ method:'POST', body:{} }); }
    if (name === 'reschedule') {
      const data = await api('/api/availability?service_id=tyre_change'); const slots = list(data,'slots');
      const dialog = document.createElement('dialog'); dialog.innerHTML = `<form><h2>Nový termín</h2><label>Volný termín<select name="slot_id" required>${slots.map(slot=>`<option value="${esc(slot.id ?? slot.slot_id)}">${date(slot.start_at ?? slot.start)} · ${esc(slot.resource_id ?? slot.bay_id ?? '')}</option>`).join('')}</select></label><p class="error" role="alert"></p><div class="actions"><button type="submit" ${slots.length ? '' : 'disabled'}>Potvrdit změnu</button><button type="button" data-close>Zavřít</button></div></form>`;
      document.body.append(dialog); dialog.showModal(); dialog.querySelector('[data-close]').onclick=()=>{dialog.close();dialog.remove();}; dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await api(`/api/admin/orders/${encodeURIComponent(id)}/reschedule`,{method:'POST',body:{slot_id:new FormData(e.target).get('slot_id')}});dialog.close();dialog.remove();await render();}catch(error){dialog.querySelector('.error').textContent=error.message;}}; return;
    }
    if (name === 'activate') { if (!confirm('Schválit a aktivovat tuto předloženou verzi rulebooku? Změna pravomocí ovlivní další agentické kroky.')) return; await api(`/api/admin/rulebooks/${encodeURIComponent(id)}/activate`,{method:'POST',body:{}}); }
    if (name === 'approve' || name === 'reject') await api(`/api/admin/approvals/${encodeURIComponent(id)}/decide`,{method:'POST',body:{decision:name === 'approve' ? 'approved' : 'rejected'}});
    if (name === 'mandate') await api(`/api/admin/mandates/${encodeURIComponent(id)}/approve`,{method:'POST',body:{}});
    feedback('Rozhodnutí bylo uloženo.'); await render();
  } catch (error) { const inline = name === 'customer-mandate' && document.getElementById('mandate-error'); if (inline) inline.textContent = error.message; else feedback(error.message); } finally { button.disabled = false; }
});
document.getElementById('login-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;const button=form.querySelector('[type=submit]');button.disabled=true;try{await api('/api/login',{method:'POST',body:Object.fromEntries(new FormData(form))});form.reset();document.getElementById('login-dialog').close();await session();await render();}catch(error){document.getElementById('login-error').textContent=error.message;}finally{button.disabled=false;}});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'agent-claim-form') return;
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await api('/api/agent/identity/confirm', {method:'POST',body:{claim_attempt_token:claimAttempt,user_code:new FormData(form).get('user_code')}});
    history.replaceState(null, '', '/agent/claim');
    document.getElementById('content').innerHTML = '<article class="card"><h2>Agent byl propojen</h2><p>Váš agent nyní může pokračovat. Rezervace a platba se řídí vaším schváleným mandátem.</p><a class="button" href="/agent/access">Spravovat přístupy agentů</a></article>';
  } catch (error) { document.getElementById('claim-error').textContent = error.message; }
  finally { button.disabled = false; }
});
await session().catch(()=>{}); await render();
