import { api, list, escapeHTML as esc, date } from './api.js';
const main = document.querySelector('main');
const handoru = location.pathname.startsWith('/handoru');
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
  document.getElementById('session').innerHTML = actor ? `<span>${esc(actor.id)} · ${esc(actor.role)}</span> ${action('Odhlásit', 'logout', '')}` : action('Přihlásit se','login','');
}
async function render() {
  const tabs = handoru ? handoruTabs : adminTabs;
  main.innerHTML = `<p class="eyebrow">${handoru ? 'Handoru' : 'Pneu 007 · provoz'}</p><h1>${handoru ? 'Audit a provoz agenta' : 'Administrace'}</h1><nav class="tabs" aria-label="Pracovní pohledy">${Object.entries(tabs).map(([key,label]) => `<button data-tab="${key}" aria-current="${selected === key}">${label}</button>`).join('')}</nav><section id="content" aria-live="polite"><p role="status">Načítání…</p></section>`;
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
  } catch (error) { feedback(error.message); } finally { button.disabled = false; }
});
document.getElementById('login-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;const button=form.querySelector('[type=submit]');button.disabled=true;try{await api('/api/login',{method:'POST',body:Object.fromEntries(new FormData(form))});form.reset();document.getElementById('login-dialog').close();await session();await render();}catch(error){document.getElementById('login-error').textContent=error.message;}finally{button.disabled=false;}});
await session().catch(()=>{}); await render();
