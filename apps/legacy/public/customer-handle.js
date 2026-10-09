const API = '/api/handle/customer/v1';
const content = document.querySelector('#content');
const feedback = document.querySelector('#feedback');
const identity = document.querySelector('#identity');
const main = document.querySelector('#main');
const params = new URLSearchParams(location.search);
let session = { customer: null };
let authMode = 'login';

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function notice(message, error = false) {
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
  feedback.hidden = !message;
}
async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (session.csrf_token) headers['X-CSRF-Token'] = session.csrf_token;
  }
  const response = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && session.customer) {
      session = { customer: null };
      renderIdentity();
      renderAuth();
    }
    throw new Error(result.error_description || result.error?.message || result.message || 'Požadavek se nepodařilo dokončit. Zkuste to znovu.');
  }
  return result;
}
function field(label, name, type = 'text', value = '', required = false, autocomplete) {
  const wrapper = el('label', undefined, 'field');
  wrapper.append(el('span', label, 'lbl'));
  const input = el('input', undefined, 'input');
  Object.assign(input, { name, type, value, required });
  if (autocomplete) input.autocomplete = autocomplete;
  if (type === 'password') input.minLength = 12;
  wrapper.append(input);
  return { wrapper, input };
}
function check(label, name, required = false) {
  const wrapper = el('label', undefined, 'check');
  const input = el('input');
  Object.assign(input, { type: 'checkbox', name, required });
  wrapper.append(input, el('span', label));
  return { wrapper, input };
}
function button(label, onClick, className = 'btn btn-line') {
  const node = el('button', label, className);
  node.type = 'button';
  if (onClick) node.addEventListener('click', () => run(node, onClick));
  return node;
}
async function run(control, action) {
  control.disabled = true;
  notice('Zpracovávání…');
  try { await action(); } catch (error) { notice(error.message || 'Spojení se službou se nezdařilo.', true); }
  finally { control.disabled = false; }
}
function formSubmit(form, label, action) {
  const submit = el('button', label, 'btn btn-green');
  submit.type = 'submit';
  const actions = el('div', undefined, 'actions');
  actions.append(submit);
  form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); run(submit, action); });
}
function surface(title) {
  const card = el('section', undefined, 'surface');
  card.append(el('h2', title));
  return card;
}
function metadata(entries) {
  const list = el('dl', undefined, 'metadata');
  for (const [label, value] of entries) {
    list.append(el('dt', label), el('dd', value === null || value === undefined || value === '' ? '—' : value));
  }
  return list;
}
function date(value) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('cs-CZ') : String(value ?? '—'); }
const statusLabel = value => ({ pending: 'Čeká na schválení', active: 'Aktivní', approved: 'Schváleno', revoked: 'Odvoláno', expired: 'Platnost vypršela' })[value] || 'Stav není dostupný';
const scopeLabel = value => ({ a2a: 'Komunikace s firmami', 'customer.tools': 'Zákaznické nástroje' })[value] || 'Další povolená činnost';
const serviceLabel = value => ({ tyre_change: 'Přezutí pneumatik', wheel_swap: 'Výměna kompletních kol' })[value] || 'Neuvedená služba';
const vehicleLabel = value => ({ personal: 'Osobní auto', suv: 'SUV', van: 'Dodávka' })[value] || 'Neuvedené vozidlo';
function idParam(key) {
  const values = params.getAll(key);
  if (!values.length) return null;
  if (values.length !== 1 || !/^[A-Za-z0-9._:-]{1,200}$/.test(values[0])) throw new Error('Odkaz obsahuje neplatný identifikátor. Otevřete nový ověřovací odkaz od agenta.');
  return values[0];
}
function renderIdentity() {
  identity.replaceChildren();
  if (!session.customer) return;
  identity.append(el('span', session.customer.email), button('Odhlásit', async () => {
    await api('/logout', {});
    session = { customer: null };
    renderIdentity();
    renderAuth();
    notice('Jste odhlášeni.');
  }, 'btn btn-line btn-sm'));
}
function renderAuth() {
  const grid = el('div', undefined, 'customer-grid');
  const card = surface('Vítejte v Handle');
  const tabs = el('div', undefined, 'auth-tabs');
  for (const [mode, label] of [['login', 'Přihlásit se'], ['signup', 'Vytvořit účet']]) {
    const tab = button(label, null, '');
    tab.setAttribute('aria-current', String(mode === authMode));
    tab.addEventListener('click', () => { authMode = mode; renderAuth(); });
    tabs.append(tab);
  }
  const form = el('form');
  const email = field('Email', 'email', 'email', '', true, 'email');
  const password = field('Heslo', 'password', 'password', '', true, authMode === 'signup' ? 'new-password' : 'current-password');
  if (authMode === 'login') password.input.removeAttribute('minlength');
  form.append(email.wrapper, password.wrapper);
  let name, phone;
  if (authMode === 'signup') {
    form.append(el('p', 'Použijte alespoň 12 znaků. Jméno a telefon jsou volitelné; jejich sdílení povolíte zvlášť.', 'hint'));
    name = field('Jméno (volitelné)', 'name', 'text', '', false, 'name');
    phone = field('Telefon (volitelný)', 'phone', 'tel', '', false, 'tel');
    form.append(name.wrapper, phone.wrapper);
  }
  formSubmit(form, authMode === 'login' ? 'Přihlásit se' : 'Vytvořit zákaznický účet', async () => {
    const body = { email: email.input.value.trim(), password: password.input.value };
    if (name?.input.value.trim()) body.name = name.input.value.trim();
    if (phone?.input.value.trim()) body.phone = phone.input.value.trim();
    session = await api('/' + authMode, body);
    if (!session.csrf_token) session = await api('/session');
    notice('Jste přihlášeni do zákaznického Handle účtu.');
    await renderAccount();
  });
  card.append(tabs, form);
  const intro = el('aside', undefined, 'intro');
  intro.append(el('h2', 'Jedna identita. Oddělené přístupy.'), el('p', 'Váš osobní agent se připojí až po vašem souhlasu. Každá zapojená firma získá vlastní omezený přístup a pouze údaje, které povolíte.'), el('p', 'Pro rezervaci nebo platbu schvalujete konkrétní mandát. Přístup můžete kdykoliv odvolat.'));
  grid.append(card, intro);
  content.replaceChildren(grid);
  main.setAttribute('aria-busy', 'false');
}
async function consentCard(connectionId) {
  const preview = await api('/connections/' + encodeURIComponent(connectionId));
  const connection = preview.connection || preview;
  const card = surface('Připojit osobního agenta');
  card.append(el('p', 'Ověřte jméno a kód s agentem, kterého chcete připojit. Agent pak může přistupovat k zapojeným firmám v rozsahu tohoto souhlasu, bez dalšího firemního přihlášení. Nákup vyžaduje samostatný mandát.'), metadata([
    ['Agent', connection.agent_name || connection.display_name || 'Osobní agent'], ['Stav', statusLabel(connection.status)], ['Platnost žádosti', date(connection.expires_at)]
  ]));
  if (connection.status !== 'pending') {
    card.append(el('p', 'Tato žádost již není dostupná pro nové schválení. Aktuální přístupy najdete v přehledu níže.', 'hint'));
    return card;
  }
  const form = el('form');
  const code = field('Šestimístný kód od vašeho agenta', 'user_code', 'text', '', true, 'one-time-code');
  code.input.inputMode = 'numeric'; code.input.pattern = '[0-9]{6}'; code.input.maxLength = 6;
  const scopeGroup = el('fieldset');
  scopeGroup.append(el('legend', 'Povolené činnosti'));
  const a2a = check('Komunikace s firmami a vyjednávání nabídek', 'a2a');
  const tools = check('Zákaznické nástroje v mezích schváleného mandátu', 'customer.tools');
  scopeGroup.append(el('p', 'Vyberte alespoň jednu činnost. Pro samotnou komunikaci stačí první možnost.', 'hint'), a2a.wrapper, tools.wrapper);
  const sharing = el('fieldset');
  sharing.append(el('legend', 'Údaje sdílené se zapojenými firmami'));
  const shared = ['name', 'email', 'phone'].map((name, index) => check(['Jméno', 'Email', 'Telefon'][index], name));
  shared.forEach(entry => sharing.append(entry.wrapper));
  const consent = check('Souhlasím, aby tento osobní agent v uvedeném rozsahu přistupoval k zapojeným firmám a sdílel s nimi vybrané údaje. Rezervace a platby vyžadují samostatný mandát pro konkrétní firmu.', 'consent', true);
  form.append(code.wrapper, scopeGroup, sharing, consent.wrapper);
  formSubmit(form, 'Schválit připojení agenta', async () => {
    const scopes = [a2a, tools].filter(entry => entry.input.checked).map(entry => entry.input.name);
    if (!scopes.length) throw new Error('Vyberte alespoň jednu povolenou činnost agenta.');
    await api('/connections/' + encodeURIComponent(connectionId) + '/approve', { user_code: code.input.value, scopes, shared_fields: shared.filter(entry => entry.input.checked).map(entry => entry.input.name) });
    await renderAccount();
    notice('Agent je připojen v rozsahu, který jste schválili.');
  });
  card.append(form);
  return card;
}
function accessCard(title, items, kind) {
  const card = surface(title);
  if (!items.length) { card.append(el('p', kind === 'connections' ? 'Zatím nemáte připojeného osobního agenta.' : 'Zatím nemáte povolený přístup k žádné firmě.', 'empty')); return card; }
  const list = el('ul', undefined, 'access-list');
  for (const item of items) {
    const row = el('li');
    row.append(el('h3', kind === 'connections' ? item.agent_name || item.display_name || 'Osobní agent' : item.business_name || item.business_id || 'Zapojená firma'));
    row.append(metadata([['Stav', statusLabel(item.status)], ...(kind === 'grants' ? [['Web firmy', item.resource_url]] : []), ['Sdílené údaje', (item.shared_fields || []).map(value => ({ name: 'Jméno', email: 'Email', phone: 'Telefon' })[value] || 'Další údaj').join(', ') || 'Žádné']]));
    const scopes = el('div');
    for (const scope of item.scopes || []) scopes.append(el('span', scopeLabel(scope), 'badge'));
    row.append(scopes);
    if (!['revoked', 'expired'].includes(item.status)) {
      const actions = el('div', undefined, 'actions');
      actions.append(button(kind === 'connections' ? 'Odvolat agenta a jeho přístupy' : 'Odvolat přístup k firmě', async () => {
        await api('/' + kind + '/' + encodeURIComponent(item.id) + '/revoke', {});
        await renderAccount();
        notice('Přístup byl odvolán. Již přijaté rezervace a platby tím nejsou zrušeny.');
      }, 'btn btn-line btn-sm'));
      row.append(actions);
    }
    list.append(row);
  }
  card.append(list);
  return card;
}
function profileCard() {
  const card = surface('Váš profil');
  card.append(el('p', 'Změna emailu nemění vaši zákaznickou identitu. Údaje se sdílejí pouze v povoleném rozsahu.', 'hint'));
  const form = el('form');
  const email = field('Email', 'email', 'email', session.customer.email, true, 'email');
  const name = field('Jméno', 'name', 'text', session.customer.name || '', false, 'name');
  const phone = field('Telefon', 'phone', 'tel', session.customer.phone || '', false, 'tel');
  form.append(email.wrapper, name.wrapper, phone.wrapper);
  formSubmit(form, 'Uložit profil', async () => {
    await api('/profile', { email: email.input.value.trim(), name: name.input.value.trim(), phone: phone.input.value.trim() });
    session = await api('/session');
    renderIdentity();
    notice('Profil byl uložen.');
  });
  card.append(form);
  return card;
}
async function mandateCard(businessId, mandateId, connectionId) {
  if (!connectionId) throw new Error('Odkaz pro schválení mandátu musí obsahovat připojení osobního agenta.');
  const path = '/businesses/' + encodeURIComponent(businessId) + '/mandates/' + encodeURIComponent(mandateId);
  const review = await api(path + '?connection_id=' + encodeURIComponent(connectionId));
  const mandate = review.mandate;
  const card = surface('Schválit konkrétní mandát');
  const money = value => Number.isSafeInteger(value) ? (value / 100).toLocaleString('cs-CZ', { style: 'currency', currency: 'CZK' }) : '—';
  card.append(el('p', 'Zkontrolujte firmu, službu a limity. Souhlas platí pouze pro tento případ u této firmy.'), metadata([
    ['Firma', review.business.business_id], ['Web firmy', review.business.resource_url], ['Požadovaná služba', serviceLabel(mandate.service_spec?.service_id)],
    ['Vozidlo', vehicleLabel(mandate.service_spec?.vehicle_type)], ['Kola', mandate.service_spec ? `${mandate.service_spec.wheel_count} × ${mandate.service_spec.wheel_size_inches}″, ${mandate.service_spec.rim_type === 'alu' ? 'hliníkové disky' : 'ocelové disky'}; runflat: ${mandate.service_spec.runflat ? 'ano' : 'ne'}, TPMS: ${mandate.service_spec.tpms ? 'ano' : 'ne'}` : '—'],
    ['Celkový limit', money(mandate.max_total_minor)], ['Limit zálohy', money(mandate.max_deposit_minor)], ['Platba', mandate.payment_mode === 'deposit' ? 'Záloha' : mandate.payment_mode === 'full' ? 'Celá částka' : mandate.payment_mode],
    ['Činnost', mandate.mode === 'book' ? 'Rezervace v mezích mandátu' : 'Pouze doporučení'], ['Dokončení služby do', date(mandate.latest_service_end)], ['Mandát platí do', date(mandate.expires_at)], ['Stav', statusLabel(mandate.status)]
  ]));
  card.append(el('p', mandate.network === 'local' ? 'Platba: local_demo — lokální simulace, bez skutečného převodu peněz.' : 'Platba: Cardano Preprod — testovací síť.', 'review-note'));
  card.append(metadata([['Dodatečné služby', mandate.allow_extras ? 'Povoleny' : 'Nepovoleny']]));
  if (mandate.network !== 'local') card.append(metadata([['Příjemce', mandate.seller_id], ['Platební aktivum', mandate.asset], ['Limit aktiva', mandate.max_asset_quantity], ['Limit síťového poplatku', mandate.max_network_fee]]));
  const hash = review.mandate_hash;
  if (mandate.status === 'pending' && (typeof hash !== 'string' || !hash.length)) card.append(el('p', 'Schválení není dostupné. Načtěte mandát znovu.', 'hint'));
  if (mandate.status === 'pending' && typeof hash === 'string' && hash.length) {
    const form = el('form');
    const consent = check('Souhlasím s tímto konkrétním mandátem, službou, časem a platebními limity pro uvedenou firmu.', 'mandate_consent', true);
    form.append(consent.wrapper);
    formSubmit(form, 'Schválit tento mandát', async () => {
      await api(path + '/approve', { connection_id: connectionId, mandate_hash: hash });
      await renderAccount();
      notice('Tento mandát byl schválen. Agent může pokračovat pouze v jeho mezích.');
    });
    card.append(form);
  }
  return card;
}
async function renderAccount() {
  renderIdentity();
  if (!session.customer) { renderAuth(); return; }
  main.setAttribute('aria-busy', 'true');
  content.replaceChildren(el('p', 'Načítání vašich přístupů…'));
  try {
    const connectionId = idParam('connection');
    const businessId = idParam('business');
    const mandateId = idParam('mandate');
    if (Boolean(businessId) !== Boolean(mandateId)) throw new Error('Odkaz pro mandát musí uvádět firmu i mandát.');
    const access = await api('/access');
    if (!session.customer) return;
    const grid = el('div', undefined, 'customer-grid');
    const stack = el('div', undefined, 'stack');
    if (businessId && mandateId) stack.append(await mandateCard(businessId, mandateId, connectionId));
    else if (connectionId) stack.append(await consentCard(connectionId));
    if (!session.customer) return;
    stack.append(accessCard('Váš osobní agent', access.connections || [], 'connections'), accessCard('Povolené firmy', access.grants || [], 'grants'));
    grid.append(stack, profileCard());
    content.replaceChildren(grid);
  } catch (error) {
    if (session.customer) {
      const card = surface('Přehled se nepodařilo načíst');
      card.append(el('p', error.message), button('Zkusit znovu', renderAccount));
      content.replaceChildren(card);
    }
    notice(error.message, true);
  } finally { main.setAttribute('aria-busy', 'false'); }
}
try {
  session = await api('/session');
  await renderAccount();
} catch (error) {
  content.replaceChildren(el('p', 'Zákaznická Handle služba není dostupná.'), button('Načíst znovu', () => location.reload()));
  notice(error.message, true);
  main.setAttribute('aria-busy', 'false');
}
