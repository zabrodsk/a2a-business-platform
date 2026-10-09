import { api, list, escapeHTML as esc } from './api.js';
import { orderOf, orderStatus, paymentStatus, shortReference, serviceLabel, vehicleLabel, pragueDay, dayLabel, timeLabel, moneyLabel, matchesSearch, availableOrderActions } from './admin-data.js';

const main = document.getElementById('main');
const tabs = {
  overview: ['Přehled', 'Co se právě děje v servisu.'],
  orders: ['Objednávky', 'Zakázky, zákazníci a jejich aktuální stav na jednom místě.'],
  calendar: ['Kalendář', 'Potvrzené termíny a dočasné blokace kapacity. Časy jsou v Praze.'],
  customers: ['Zákazníci', 'Kontakty, vozidla a přehled souvisejících zakázek.'],
  inventory: ['Sklad', 'Dostupnost položek a dodací lhůty od testovacích dodavatelů.'],
  partners: ['Dodavatelé', 'Přehled fiktivních partnerů a jejich sortimentu.'],
};
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  orders: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 11h18M7 15h3M14 15h3"/>',
  customers: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5"/>',
  inventory: '<path d="m3 7 9-5 9 5v10l-9 5-9-5zM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5"/>',
  partners: '<path d="M3 21V7h11v14M14 11h7v10M7 11h3M7 15h3M17 15h1M1 21h22"/>',
};
const filters = Object.fromEntries(Object.keys(tabs).map(key => [key, { search: '', status: 'all', day: '', period: 'upcoming', customerId: '' }]));
let actor = null, data = null, generation = 0;
let selected = Object.hasOwn(tabs, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let toastTimer;
const terminal = new Set(['cancelled', 'refunded', 'expired', 'service_completed']);
const badge = value => `<span class="admin-status tone-${esc(value.tone)}">${esc(value.label)}</span>`;
const button = (label, action, id = '', kind = 'secondary') => `<button type="button" class="${esc(kind)}" data-admin-action="${esc(action)}" data-id="${esc(id)}">${esc(label)}</button>`;
const technical = value => `<details class="admin-technical"><summary>Technické údaje a původní záznam</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
const empty = (title, note = '') => `<div class="admin-empty"><strong>${esc(title)}</strong>${note ? `<p>${esc(note)}</p>` : ''}</div>`;
const fields = values => `<dl class="admin-fields">${values.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value ?? 'Neuvedeno')}</dd>`).join('')}</dl>`;
function table(headers, rows, caption) {
  return `<div class="admin-table-wrap"><table class="admin-table" aria-label="${esc(caption)}"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, index) => `<td data-label="${esc(headers[index])}"${headers[index] === 'Akce' ? ' class="admin-row-actions-cell"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function toast(message) {
  clearTimeout(toastTimer);
  const el = document.getElementById('toast'); el.textContent = message; el.style.display = 'block';
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
}
function sessionLabel() {
  const roles = { owner: 'Majitel servisu', staff: 'Obsluha servisu', human_customer: 'Zákaznický účet' };
  document.getElementById('session').innerHTML = actor
    ? `<span title="${esc(actor.id)}">${esc(roles[actor.role] ?? 'Přihlášený účet')}</span>${button('Odhlásit se', 'logout')}`
    : button('Přihlásit se', 'login');
}
function loginPage(message = '') {
  data = null;
  main.innerHTML = `<div class="admin-login"><section class="admin-login-intro"><p class="eyebrow">Pneu 007 · provoz servisu</p><h1>Váš servis.<br>Jasný přehled.</h1><p>Objednávky, termíny, zákazníci a sklad. Vše potřebné pro každodenní práci na jednom místě.</p></section><section class="admin-login-card"><h2>Přihlášení do provozu</h2><p>Použijte účet majitele nebo pracovníka Pneu 007.</p><form id="admin-login-form"><label>Uživatelské jméno<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label><label>Heslo<input name="password" type="password" autocomplete="current-password" required></label><p class="error" role="alert" id="admin-login-error">${esc(message)}</p><button type="submit">Přihlásit se</button></form><p>Přihlášení do <a href="/handle">Handle</a> pro správu agenta a pravidel je samostatné.</p></section></div>`;
}
function accessPage() {
  data = null;
  main.innerHTML = `<section class="admin-panel">${empty('Správa servisu vyžaduje pracovní účet', 'Tento účet nemá přístup k objednávkám ostatních zákazníků ani ke skladu.')}<div class="admin-actions">${button('Odhlásit a použít jiný účet', 'logout')}<a class="button secondary" href="/">Přejít na web</a></div></section>`;
}
function shell() {
  main.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><p class="admin-nav-label">Správa servisu</p><nav class="admin-menu" aria-label="Provozní přehledy">${Object.entries(tabs).map(([key, [label]]) => `<button type="button" data-admin-tab="${key}"${selected === key ? ' aria-current="page"' : ''}><span class="admin-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[key]}</svg></span>${label}</button>`).join('')}</nav><div class="admin-sidebar-note"><strong>Firemní agent</strong><p>Pravidla, oprávnění a schválení spravujete v Handle.</p><a href="/handle">Otevřít Handle →</a></div></aside><section class="admin-main"><div class="admin-heading"><div><p class="eyebrow">Pneu 007 · správa provozu</p><h1 id="admin-title" tabindex="-1"></h1><p class="admin-description" id="admin-description"></p></div>${button('Obnovit data', 'refresh')}</div><section id="admin-content" aria-live="polite"><p role="status">Načítání provozních dat…</p></section></section></div>`;
  updateHeading();
}
function updateHeading() {
  document.getElementById('admin-title').textContent = tabs[selected][0];
  document.getElementById('admin-description').textContent = tabs[selected][1];
  document.querySelectorAll('[data-admin-tab]').forEach(el => {
    if (el.dataset.adminTab === selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}
function orderRecord(id) { return data?.orders.find(record => orderOf(record).id === id); }
function customerName(record) {
  const order = orderOf(record);
  return record.contact?.name || data.customers.find(customer => customer.id === order.customer_id)?.name || 'Jméno neuvedeno';
}
function resourceName(id) { return data.resources.find(resource => resource.id === id)?.name ?? 'Servisní box'; }
function toolbar(searchLabel, extra = '') {
  const f = filters[selected];
  return `<div class="admin-toolbar"><label>${esc(searchLabel)}<input type="search" data-admin-filter="search" value="${esc(f.search)}" placeholder="Začněte psát…"></label>${extra}<span id="admin-count" role="status"></span></div><div id="admin-results"></div>`;
}
function options(values, selectedValue) { return values.map(([value, label]) => `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`).join(''); }
function appointments(bookings, showDate = false) {
  if (!bookings.length) return empty('Zatím žádné potvrzené termíny', 'Nové rezervace se zde objeví po potvrzení v systému.');
  return bookings.map(booking => {
    const record = orderRecord(booking.order_id), order = record && orderOf(record);
    return `<article class="admin-appointment"><div class="admin-appointment-time">${esc(timeLabel(booking.start_at))}<small class="admin-cell-sub">${esc(timeLabel(booking.end_at))}</small></div><div><strong class="admin-cell-title">${esc(record ? customerName(record) : 'Zákazník')}</strong>${showDate ? `<span class="admin-cell-sub">${esc(dayLabel(booking.start_at))}</span>` : ''}<span class="admin-cell-sub">${esc(record ? serviceLabel(record.quote?.price?.service_spec) : 'Servisní rezervace')} · ${esc(resourceName(booking.resource_id))}</span>${badge(orderStatus({ status: booking.status }))}</div>${order ? button('Detail', 'detail', order.id) : ''}</article>`;
  }).join('');
}
function overview() {
  const today = pragueDay(), upcoming = data.calendar.filter(b => b.status === 'confirmed' && Date.parse(b.end_at) > Date.now()).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const todayBookings = upcoming.filter(b => pragueDay(b.start_at) === today);
  const open = data.orders.filter(record => !terminal.has(orderOf(record).status));
  const attention = open.filter(record => ['draft', 'awaiting_payment', 'owner_approval_required', 'cancel_requested', 'refund_pending'].includes(orderOf(record).status) || paymentStatus(record).tone === 'warn');
  const low = data.inventory.filter(item => item.stock_quantity === 0);
  const kpis = [['Dnešní termíny', todayBookings.length, 'Zbývající potvrzené rezervace'], ['Otevřené zakázky', open.length, 'Všechny nedokončené objednávky'], ['Zákazníci', data.customers.length, 'Kontakty v provozním systému'], ['Přijaté poptávky', data.overview.pending_inquiries ?? 0, 'Celkem zaznamenaných poptávek']];
  return `<div class="admin-kpis">${kpis.map(([label, value, note]) => `<article class="admin-kpi"><span class="admin-kpi-label">${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</div><div class="admin-grid"><article class="admin-panel"><div class="admin-panel-heading"><div><h2>Nejbližší termíny</h2><p>${esc(todayBookings.length ? dayLabel(new Date()) : 'Následující potvrzené rezervace')}</p></div>${button('Celý kalendář', 'tab', 'calendar')}</div>${appointments((todayBookings.length ? todayBookings : upcoming).slice(0, 5), true)}</article><article class="admin-panel"><div class="admin-panel-heading"><div><h2>K vyřízení</h2><p>Rozpracované zakázky a položky k prověření</p></div>${button('Objednávky', 'tab', 'orders')}</div>${attention.length ? attention.slice(0, 4).map(record => `<div class="admin-appointment"><div><span class="admin-cell-sub">${esc(shortReference(orderOf(record).id))}</span></div><div><strong class="admin-cell-title">${esc(customerName(record))}</strong>${badge(orderStatus(record))}</div>${button('Detail', 'detail', orderOf(record).id)}</div>`).join('') : empty('Není co prověřovat', 'Žádné rozpracované objednávky nevyžadují pozornost.')}${data.holds.length ? `<p class="admin-payment-note">Dočasné blokace termínů: <strong>${data.holds.length}</strong>. Podrobnosti najdete v kalendáři.</p>` : ''}${low.length ? `<p class="admin-payment-note">${low.length} položek není skladem. ${button('Otevřít sklad', 'tab', 'inventory')}</p>` : ''}</article></div><article class="admin-panel"><div class="admin-panel-heading"><div><h2>Poslední objednávky</h2><p>Posledních pět zakázek podle záznamů systému</p></div>${button('Všechny objednávky', 'tab', 'orders')}</div>${orderTable(data.orders.slice(0, 5), true)}</article><details class="admin-technical"><summary>Testovací platební prostředí</summary><p>Cena služby v Kč, testovací síťová platba a fyzické provedení služby se evidují samostatně.</p><p>${esc(data.overview.payment_provider?.simulation ? 'Místní simulace — bez blockchainové transakce.' : `Platební prostředí: ${data.overview.payment_provider?.network ?? 'není dostupné'}.`)}</p></details>`;
}
function orderTable(records, compact = false) {
  if (!records.length) return empty('Žádné odpovídající objednávky', 'Zkuste jiný text nebo stav.');
  const headers = ['Zákazník / zakázka', 'Termín', 'Cena služby', 'Stav', ...(compact ? [] : ['Platba']), 'Akce'];
  const rows = records.map(record => {
    const order = orderOf(record), spec = record.quote?.price?.service_spec;
    const cells = [`<strong class="admin-cell-title">${esc(customerName(record))}</strong><span class="admin-cell-sub">${esc(serviceLabel(spec))} · ${esc(shortReference(order.id))}</span>`, record.booking ? `<strong class="admin-cell-title">${esc(dayLabel(record.booking.start_at))}</strong><span class="admin-cell-sub">${esc(timeLabel(record.booking.start_at))}–${esc(timeLabel(record.booking.end_at))}</span>` : '<span class="admin-cell-sub">Termín nepotvrzen</span>', `<strong class="admin-cell-title">${esc(moneyLabel(record.quote?.price?.total_minor))}</strong><span class="admin-cell-sub">Doplatek: ${esc(moneyLabel(order.balance_minor))}</span>`, badge(orderStatus(record))];
    if (!compact) cells.push(badge(paymentStatus(record)));
    cells.push(`<div class="admin-row-actions">${button('Detail', 'detail', order.id)}</div>`); return cells;
  });
  return table(headers, rows, 'Objednávky pneuservisu');
}
function renderResults() {
  const f = filters[selected]; let records = [], html = '';
  if (selected === 'orders') {
    records = data.orders.filter(record => {
      const order = orderOf(record), contact = record.contact ?? {};
      const status = f.status === 'all' || (f.status === 'open' ? !terminal.has(order.status) : f.status === 'attention' ? paymentStatus(record).tone === 'warn' || order.status === 'owner_approval_required' : order.status === f.status);
      return status && (!f.customerId || order.customer_id === f.customerId) && matchesSearch(f.search, [customerName(record), data.customers.find(c => c.id === order.customer_id)?.name, contact.email, contact.phone, order.id, serviceLabel(record.quote?.price?.service_spec)]);
    });
    html = orderTable(records);
  }
  if (selected === 'calendar') {
    records = data.calendar.filter(b => (f.period === 'all' || b.status === 'confirmed' && Date.parse(b.end_at) > Date.now()) && (!f.day || pragueDay(b.start_at) === f.day)).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    const days = Map.groupBy ? Map.groupBy(records, b => pragueDay(b.start_at)) : records.reduce((result, b) => { const key = pragueDay(b.start_at); if (!result.has(key)) result.set(key, []); result.get(key).push(b); return result; }, new Map());
    html = records.length ? `<article class="admin-panel admin-schedule">${[...days.values()].map(bookings => `<section><h3>${esc(dayLabel(bookings[0].start_at))}</h3>${appointments(bookings)}</section>`).join('')}</article>` : `<article class="admin-panel">${empty('Pro tento výběr nejsou žádné rezervace', 'Změňte datum nebo zobrazte také historii.')}</article>`;
    if (data.holds.length) html += `<article class="admin-panel"><div class="admin-panel-heading"><div><h2>Dočasně blokované termíny</h2><p>Blokace není potvrzená rezervace. Nejistou platbu je nutné nejprve ověřit.</p></div></div>${data.holds.map(hold => `<div class="admin-hold"><strong class="admin-cell-title">${esc(orderRecord(hold.order_id) ? customerName(orderRecord(hold.order_id)) : shortReference(hold.order_id))}</strong><p>${hold.status === 'reconciliation' ? 'Čeká na prověření platby' : 'Probíhá příprava rezervace'} · platnost do ${esc(dayLabel(hold.expires_at))} ${esc(timeLabel(hold.expires_at))}</p>${button('Detail objednávky', 'detail', hold.order_id)}</div>`).join('')}</article>`;
  }
  if (selected === 'customers') {
    records = data.customers.filter(c => matchesSearch(f.search, [c.name, c.email, c.phone, ...data.vehicles.filter(v => v.customer_id === c.id).flatMap(v => [v.make, v.model, v.plate])]));
    html = records.length ? `<div class="admin-card-grid">${records.map(c => {
      const vehicles = data.vehicles.filter(v => v.customer_id === c.id), count = data.orders.filter(r => orderOf(r).customer_id === c.id).length;
      return `<article class="admin-person-card"><h2>${esc(c.name)}</h2><p>${esc(c.email)}<br>${esc(c.phone)}</p><p>${vehicles.map(v => `${esc(v.make)} ${esc(v.model)} · ${esc(v.plate)}`).join('<br>') || 'Vozidlo neuvedeno'}</p><span class="admin-cell-sub">Počet objednávek: ${count}</span>${button('Zobrazit zakázky', 'customer-orders', c.id)}</article>`;
    }).join('')}</div>` : empty('Žádní odpovídající zákazníci', 'Hledejte podle jména, kontaktu nebo registrační značky.');
  }
  if (selected === 'inventory') {
    records = data.inventory.filter(item => matchesSearch(f.search, [item.name, item.sku, data.partners.find(p => p.id === item.supplier_id)?.name]) && (f.status !== 'empty' || item.stock_quantity === 0));
    html = records.length ? table(['Položka', 'Dodavatel', 'Dostupnost', 'Cena / kus', 'Dodání', 'Akce'], records.map(item => [`<strong class="admin-cell-title">${esc(item.name)}</strong><span class="admin-cell-sub">${esc(item.sku)}</span>`, esc(data.partners.find(p => p.id === item.supplier_id)?.name ?? 'Neuveden'), badge({ label: `${item.stock_quantity} ks`, tone: item.stock_quantity > 0 ? 'ok' : 'warn' }), esc(moneyLabel(item.unit_price_minor)), `${esc(item.eta_days)} dnů`, `<div class="admin-row-actions">${button('Upravit stav', 'inventory', item.id)}</div>`]), 'Skladové položky') : empty('Žádné odpovídající položky', 'Zkuste jiný text nebo vypněte filtr nedostupných položek.');
  }
  if (selected === 'partners') {
    records = data.partners.filter(p => matchesSearch(f.search, [p.name, p.contact]));
    html = `<p class="admin-payment-note">Dodavatelé i jejich napojení jsou fiktivní. Tento přehled neodesílá skutečné objednávky ani zprávy.</p>` + (records.length ? `<div class="admin-card-grid">${records.map(p => `<article class="admin-person-card"><h2>${esc(p.name)}</h2><p>${esc({ tyres: 'Pneumatiky', 'workshop-consumables': 'Servisní materiál' }[p.role] ?? 'Dodavatel servisu')}</p><p>${esc(p.contact)}</p><p>Obvyklé dodání: ${esc(p.document_eta_days)} dnů</p>${button('Zobrazit sortiment', 'partner-stock', p.id)}${technical(p)}</article>`).join('')}</div>` : empty('Žádní odpovídající dodavatelé'));
  }
  document.getElementById('admin-results').innerHTML = html;
  document.getElementById('admin-count').textContent = `Zobrazeno: ${records.length}`;
}
function renderCurrent() {
  updateHeading(); if (!data) return;
  const content = document.getElementById('admin-content'); const f = filters[selected];
  if (selected === 'overview') { content.innerHTML = overview(); return; }
  if (selected === 'calendar') content.innerHTML = `<div class="admin-toolbar"><label>Datum<input type="date" data-admin-filter="day" value="${esc(f.day)}"></label><label>Termíny<select data-admin-filter="period">${options([['upcoming', 'Nadcházející potvrzené'], ['all', 'Vše včetně historie']], f.period)}</select></label>${button('Všechna data', 'clear-day')}<span id="admin-count" role="status"></span></div><div id="admin-results"></div>`;
  else content.innerHTML = toolbar({ orders: 'Hledat zákazníka nebo objednávku', customers: 'Hledat zákazníka nebo vozidlo', inventory: 'Hledat položku, SKU nebo dodavatele', partners: 'Hledat dodavatele' }[selected], selected === 'orders' ? `<label>Stav<select data-admin-filter="status">${options([['all', 'Všechny stavy'], ['open', 'Otevřené zakázky'], ['confirmed', 'Potvrzené'], ['attention', 'K prověření'], ['service_completed', 'Dokončené'], ['cancelled', 'Stornované']], f.status)}</select></label>` : selected === 'inventory' ? `<label>Dostupnost<select data-admin-filter="status">${options([['all', 'Všechny položky'], ['empty', 'Není skladem']], f.status)}</select></label>` : '');
  if (selected === 'orders' && f.customerId) {
    const scope = document.createElement('div'); scope.className = 'admin-payment-note';
    scope.innerHTML = `Zákazník: <strong>${esc(data.customers.find(c => c.id === f.customerId)?.name ?? 'Vybraný zákazník')}</strong> ${button('Zobrazit všechny zákazníky', 'clear-customer')}`;
    document.getElementById('admin-results').before(scope);
  }
  renderResults();
}
async function reload() {
  const request = ++generation;
  closeDialogs();
  main.setAttribute('aria-busy', 'true');
  const refresh = main.querySelector('[data-admin-action="refresh"]'); if (refresh) refresh.disabled = true;
  try {
    const session = await api('/api/session'); if (request !== generation) return;
    actor = session.actor; sessionLabel();
    if (!actor) { loginPage(); return; }
    if (!['owner', 'staff'].includes(actor.role)) { accessPage(); return; }
    if (!document.getElementById('admin-content')) shell();
    const results = await Promise.all(['overview', 'orders', 'calendar', 'customers', 'inventory', 'partners'].map(key => api(`/api/admin/${key}`)).concat(api('/api/services')));
    if (request !== generation) return;
    data = { overview: results[0], orders: list(results[1], 'orders'), calendar: list(results[2], 'calendar'), holds: list(results[2], 'holds'), customers: list(results[3], 'customers'), vehicles: list(results[3], 'vehicles'), inventory: list(results[4], 'inventory'), partners: list(results[5], 'partners'), resources: list(results[6], 'resources') };
    renderCurrent();
  } catch (error) {
    if (request !== generation) return;
    data = null;
    if (error.status === 401) { actor = null; sessionLabel(); loginPage('Přihlášení vypršelo. Přihlaste se znovu.'); }
    else {
      const target = document.getElementById('admin-content') ?? main;
      target.innerHTML = `<article class="admin-panel"><h2>Data se nepodařilo načíst</h2><p class="error" role="alert">${esc(error.message)}</p>${button('Zkusit znovu', 'refresh')}</article>`;
    }
  } finally {
    if (request === generation) { main.removeAttribute('aria-busy'); const current = main.querySelector('[data-admin-action="refresh"]'); if (current) current.disabled = false; }
  }
}
function selectTab(tab) {
  if (!Object.hasOwn(tabs, tab) || !data) return;
  selected = tab; history.replaceState(null, '', `#${tab}`); renderCurrent();
}
function dialog(title, subtitle, body) {
  const previous = document.activeElement, el = document.createElement('dialog');
  el.className = 'admin-dialog'; el.setAttribute('aria-labelledby', 'admin-dialog-title');
  el.innerHTML = `<div class="admin-dialog-heading"><div><h2 id="admin-dialog-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="secondary" data-dialog-close aria-label="Zavřít dialog">×</button></div>${body}`;
  el.addEventListener('click', event => { if (event.target.closest('[data-dialog-close]')) el.close(); });
  el.addEventListener('close', () => { el.remove(); if (previous?.isConnected) previous.focus(); });
  document.body.append(el); el.showModal(); return el;
}
function closeDialogs() { document.querySelectorAll('.admin-dialog').forEach(el => el.close()); }
function currentViewer(viewer, request) { return request === generation && actor === viewer && ['owner', 'staff'].includes(actor?.role) && data !== null; }
function detailBody(record) {
  const order = orderOf(record), spec = record.quote?.price?.service_spec, payment = paymentStatus(record);
  const contacts = record.contact ?? {};
  return `${fields([['Zákazník', contacts.name || customerName(record)], ['E-mail', contacts.email], ['Telefon', contacts.phone], ['Služba', serviceLabel(spec)], ['Vozidlo a kola', vehicleLabel(spec)], ['Termín', record.booking ? `${dayLabel(record.booking.start_at)} · ${timeLabel(record.booking.start_at)}–${timeLabel(record.booking.end_at)}` : 'Termín nepotvrzen'], ['Stav zakázky', orderStatus(record).label], ['Cena služby', moneyLabel(record.quote?.price?.total_minor)], ['Doplatek v evidenci', moneyLabel(order.balance_minor)], ['Platba', payment.label]])}<div class="admin-payment-note"><p>${esc(payment.note)}</p><p>Potvrzený termín ani platba samy o sobě neznamenají provedené přezutí.</p></div>`;
}
async function showOrder(id) {
  const viewer = actor, request = generation;
  const record = await api(`/api/orders/${encodeURIComponent(id)}`), order = orderOf(record);
  if (!currentViewer(viewer, request)) return;
  const actions = availableOrderActions(record, viewer.role);
  const el = dialog(`Zakázka ${shortReference(order.id)}`, customerName(record), `${detailBody(record)}<div class="admin-actions">${actions.map(a => button(a.label, a.action, order.id, a.kind)).join('')}${record.booking?.status === 'confirmed' ? `<a class="button secondary" href="/api/orders/${encodeURIComponent(order.id)}/confirmation.ics">Stáhnout do kalendáře</a>` : ''}</div>${technical(record)}`);
  el.dataset.orderId = order.id;
}
async function orderOperation(name, id) {
  const viewer = actor, request = generation;
  const record = await api(`/api/orders/${encodeURIComponent(id)}`);
  if (!currentViewer(viewer, request)) return;
  if (!availableOrderActions(record, viewer.role).some(a => a.action === name)) { toast('Stav zakázky se změnil. Obnovte data a zkontrolujte dostupné akce.'); await reload(); return; }
  closeDialogs();
  const descriptions = {
    cancel: ['Stornovat zakázku?', 'Server zruší rezervaci, nebo uloží požadavek k prověření platby. Storno samo nepotvrzuje vrácení peněz.', 'Potvrdit storno'],
    'refund-request': ['Požádat o vrácení prostředků?', 'Zakázka se stornuje a odešle se žádost o vrácení ověřených testovacích prostředků. Dokončení vrácení musí potvrdit platební poskytovatel.', 'Stornovat a požádat o vrácení'],
    'resume-payment': ['Prověřit a obnovit platbu?', 'Server prověří původní zahájený nákup. Pokračování může dokončit dříve autorizovanou testovací platbu.', 'Prověřit a obnovit'],
    'authorize-refund': ['Potvrdit žádost o vrácení?', 'Potvrzujete tuto konkrétní ověřenou žádost. Dokončené vrácení se zobrazí až po potvrzení poskytovatele.', 'Potvrdit žádost'],
  };
  if (name === 'reschedule') {
    const service = record.quote?.price?.service_spec?.service_id;
    if (!service) throw new Error('U zakázky chybí služba. Termín nelze bezpečně změnit.');
    const availability = await api(`/api/availability?service_id=${encodeURIComponent(service)}`), slots = list(availability, 'slots');
    if (!currentViewer(viewer, request)) return;
    const el = dialog('Změnit termín', customerName(record), `<form data-admin-form="reschedule"><p>Původní termín: ${esc(dayLabel(record.booking.start_at))} · ${esc(timeLabel(record.booking.start_at))}</p>${slots.length ? `<label>Nový volný termín<select name="slot_id" required><option value="">Vyberte termín</option>${slots.map(s => `<option value="${esc(s.id ?? s.slot_id)}">${esc(dayLabel(s.start_at ?? s.start))} · ${esc(timeLabel(s.start_at ?? s.start))}–${esc(timeLabel(s.end_at ?? s.end))} · ${esc(resourceName(s.resource_id ?? s.bay_id))}</option>`).join('')}</select></label>` : '<p>Pro tuto službu teď nejsou volné termíny.</p>'}<p class="error" role="alert"></p><div class="admin-actions"><button type="submit"${slots.length ? '' : ' disabled'}>Potvrdit nový termín</button><button type="button" class="secondary" data-dialog-close>Zpět</button></div></form>`);
    bindOperation(el, `/api/admin/orders/${encodeURIComponent(id)}/reschedule`, form => ({ slot_id: new FormData(form).get('slot_id') }), 'Termín byl změněn.'); return;
  }
  const [title, description, confirm] = descriptions[name];
  const el = dialog(title, customerName(record), `<form data-admin-form="operation"><p>${esc(description)}</p>${detailBody(record)}<p class="error" role="alert"></p><div class="admin-actions"><button type="submit"${['cancel', 'refund-request'].includes(name) ? ' class="danger"' : ''}>${esc(confirm)}</button><button type="button" class="secondary" data-dialog-close>Zpět</button></div></form>`);
  bindOperation(el, `/api/admin/orders/${encodeURIComponent(id)}/${name}`, () => ['resume-payment', 'authorize-refund'].includes(name) ? { confirm: true } : {}, 'Požadavek je uložen. Aktuální výsledek najdete u zakázky.');
}
function bindOperation(el, path, payload, success) {
  const viewer = actor, request = generation;
  const form = el.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault(); const submit = form.querySelector('[type="submit"]'); if (submit.disabled) return; submit.disabled = true;
    try {
      if (!currentViewer(viewer, request)) { el.close(); return; }
      await api(path, { method: 'POST', body: payload(form) });
      if (!currentViewer(viewer, request)) return;
      el.close(); const refreshGeneration = generation + 1; await reload();
      if (generation === refreshGeneration && actor?.id === viewer.id && actor?.role === viewer.role && data) toast(success);
    }
    catch (error) {
      if (!currentViewer(viewer, request)) return;
      if (error.status === 401) { ++generation; actor = null; data = null; closeDialogs(); sessionLabel(); loginPage('Přihlášení vypršelo. Přihlaste se znovu.'); }
      else form.querySelector('.error').textContent = error.message;
    }
    finally { submit.disabled = false; }
  });
}
function showInventory(id) {
  const item = data.inventory.find(v => v.id === id); if (!item) return;
  const el = dialog('Upravit stav položky', item.name, `<form><label>Množství skladem (ks)<input name="stock_quantity" type="number" min="0" step="1" value="${esc(item.stock_quantity)}" required></label><label>Dodání (dnů)<input name="eta_days" type="number" min="0" step="1" value="${esc(item.eta_days)}" required></label><p>Upravujete evidenci testovacího skladu. Tímto krokem se nic neobjednává.</p><p class="error" role="alert"></p><div class="admin-actions"><button type="submit">Uložit stav</button><button type="button" class="secondary" data-dialog-close>Zpět</button></div></form>`);
  bindOperation(el, `/api/admin/inventory/${encodeURIComponent(id)}`, form => { const values = new FormData(form); return { stock_quantity: Number(values.get('stock_quantity')), eta_days: Number(values.get('eta_days')) }; }, 'Stav skladu je uložen.');
}
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-admin-tab]'); if (tab) { selectTab(tab.dataset.adminTab); return; }
  const target = event.target.closest('[data-admin-action]'); if (!target || target.disabled) return;
  const { adminAction: action, id } = target.dataset;
  if (action === 'login') { main.querySelector('[name="username"]')?.focus(); return; }
  target.disabled = true;
  const viewer = actor, request = generation;
  try {
    if (action === 'logout') { ++generation; data = null; closeDialogs(); await api('/api/logout', { method: 'POST', body: {} }); actor = null; sessionLabel(); loginPage(); return; }
    if (action === 'refresh') { await reload(); return; }
    if (!data || !['owner', 'staff'].includes(actor?.role)) return;
    if (action === 'tab') { if (filters[id]) { filters[id].search = ''; filters[id].status = 'all'; filters[id].customerId = ''; } selectTab(id); return; }
    if (action === 'clear-day') { filters.calendar.day = ''; renderCurrent(); return; }
    if (action === 'customer-orders') { filters.orders.search = ''; filters.orders.customerId = id; filters.orders.status = 'all'; selectTab('orders'); return; }
    if (action === 'clear-customer') { filters.orders.customerId = ''; renderCurrent(); return; }
    if (action === 'partner-stock') { filters.inventory.search = data.partners.find(p => p.id === id)?.name ?? ''; filters.inventory.status = 'all'; selectTab('inventory'); return; }
    if (action === 'detail') { await showOrder(id); return; }
    if (action === 'inventory') { showInventory(id); return; }
    if (['reschedule', 'cancel', 'refund-request', 'resume-payment', 'authorize-refund'].includes(action)) await orderOperation(action, id);
  } catch (error) {
    if (['detail', 'reschedule', 'cancel', 'refund-request', 'resume-payment', 'authorize-refund'].includes(action) && !currentViewer(viewer, request)) return;
    toast(error.message);
  }
  finally { target.disabled = false; }
});
function filterChange(event) {
  const input = event.target.closest('[data-admin-filter]'); if (!input || !data) return;
  filters[selected][input.dataset.adminFilter] = input.value; renderResults();
}
document.addEventListener('input', event => { if (event.target.matches('input[data-admin-filter]')) filterChange(event); });
document.addEventListener('change', event => { if (event.target.matches('select[data-admin-filter]')) filterChange(event); });
document.addEventListener('submit', async event => {
  if (event.target.id !== 'admin-login-form') return;
  event.preventDefault(); const form = event.target, submit = form.querySelector('[type="submit"]'); if (submit.disabled) return; submit.disabled = true;
  try { await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); form.reset(); await reload(); }
  catch (error) { form.querySelector('#admin-login-error').textContent = error.message; }
  finally { form.querySelector('[name="password"]').value = ''; submit.disabled = false; }
});
window.addEventListener('hashchange', () => { const tab = location.hash.slice(1); if (Object.hasOwn(tabs, tab)) selectTab(tab); });
await reload();
