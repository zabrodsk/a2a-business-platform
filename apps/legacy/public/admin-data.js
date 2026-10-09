// Presentation only: permissions and payment evidence remain authoritative in the backend.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const orderOf = record => object(object(record).order ?? record);
const intentOf = record => object(object(record).intent ?? object(record).payment);
const status = (label, tone = 'neutral') => ({ label, tone });

export function orderStatus(record) {
  const labels = {
    draft: ['Rozpracováno', 'neutral'],
    awaiting_payment: ['Čeká na platbu', 'warn'],
    owner_approval_required: ['Čeká na majitele', 'warn'],
    confirmed: ['Rezervace potvrzena', 'ok'],
    service_completed: ['Služba dokončena', 'neutral'],
    payment_failed: ['Platba selhala', 'bad'],
    reconciliation_required: ['Vyžaduje prověření', 'warn'],
    cancel_requested: ['Storno se ověřuje', 'warn'],
    refund_pending: ['Čeká na vrácení platby', 'warn'],
    cancelled: ['Stornováno', 'neutral'],
    refunded: ['Stornováno · platba vrácena', 'neutral'],
    expired: ['Platnost vypršela', 'neutral'],
  };
  const state = orderOf(record).status;
  const entry = Object.hasOwn(labels, state) ? labels[state] : null;
  return entry ? status(...entry) : status('Stav neuveden / neznámý');
}

export function paymentStatus(record) {
  const view = object(record), order = orderOf(record), intent = intentOf(record);
  const stripe = object(view.stripe_checkout), observation = object(intent.observation);
  const simulation = intent.provider === 'local_demo' || view.simulation === true;
  const environment = simulation ? 'Lokální simulace; skutečné peníze se nepřevádějí.'
    : intent.provider === 'masumi' ? 'Masumi · Cardano Preprod, pouze testovací prostředky.' : '';
  const result = (label, tone, note = '') => ({ label, tone, note: [environment, note].filter(Boolean).join(' ') });

  // A failed reconciliation must not turn an older escrow observation into a settled payment.
  if (intent.state === 'reconciliation_required' || observation.state === 'reconciliation_required') {
    return result('Platbu je nutné prověřit', 'warn', 'Výsledek není jistý. Novou platbu nezahajujte.');
  }
  if (intent.state) {
    const observed = observation.state;
    if (['escrow_funded', 'result_submitted', 'seller_paid', 'refund_requested', 'refunded'].includes(intent.state)
      && observed !== intent.state) return result('Platební stav není doložen', 'warn', 'Nejprve ověřte stav u poskytovatele.');
    switch (intent.state) {
      case 'created': return result('Čeká na zahájení platby', 'neutral');
      case 'purchase_requested': return result('Platba se ověřuje', 'warn', 'Nákup byl zahájen; přijetí prostředků zatím není potvrzené.');
      case 'escrow_funded': return result('Prostředky v úschově', 'info', 'Escrow je financované; vyplacení firmě ani provedení služby tím není potvrzené.');
      case 'result_submitted': return result('Čeká na vyplacení', 'info', 'Výsledek byl odeslán poskytovateli. Vyplacení ani fyzické provedení služby tím není doložené.');
      case 'seller_paid': return result('Vyplaceno firmě', 'ok', 'Případné vrácení řeší majitel samostatnou kompenzací. Stav neprokazuje provedení služby.');
      case 'refund_requested': return result('Žádost o vrácení odeslána', 'warn', 'Vrácení prostředků zatím není potvrzené.');
      case 'refunded': return result('Platba vrácena', 'neutral', 'Vrácení prostředků potvrdil poskytovatel.');
      case 'failed': return result('Platba selhala', 'bad');
      default: return result('Neznámý platební stav', 'warn', 'Otevřete technický detail a prověřte záznam.');
    }
  }
  if (stripe.state) {
    const note = 'Stripe testovací režim; skutečné peníze se nepřevádějí.';
    const labels = {
      prepared: ['Platba připravena', 'neutral'], creating: ['Připravuje se platba', 'info'],
      open: ['Čeká na testovací platbu', 'warn'], processing: ['Testovací platba se zpracovává', 'info'],
      paid: ['Testovací platba přijata', 'ok'], expired: ['Platnost platby vypršela', 'neutral'],
      failed: ['Testovací platba selhala', 'bad'], reconciliation_required: ['Testovací platbu je nutné prověřit', 'warn'],
    };
    const entry = Object.hasOwn(labels, stripe.state) ? labels[stripe.state] : ['Neznámý platební stav', 'warn'];
    return { ...status(...entry), note: `${note}${stripe.state === 'paid' ? ' Přijetí platby neprokazuje provedení služby.' : ''}` };
  }
  if (order.origin === 'fixture' && Number.isSafeInteger(order.amount_minor) && order.amount_minor > 0) {
    return { ...status('Historický demo záznam', 'neutral'), note: 'Importovaná částka je ukázková evidence; není potvrzením aktuální platby u poskytovatele.' };
  }
  return result('Platba neevidována', 'neutral', 'Z dostupného záznamu nelze potvrdit přijetí platby.');
}

export function shortReference(id) {
  if (typeof id !== 'string' || !id.trim()) return 'Neuvedeno';
  const fixture = /^order-fixture-(\d+)$/.exec(id);
  if (fixture) return `OBJ ${fixture[1]}`;
  if (id.startsWith('order-')) return `OBJ ${id.slice(6, 14).toUpperCase()}`;
  return id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

export function serviceLabel(spec) {
  const labels = { tyre_change: 'Přezutí pneumatik', wheel_swap: 'Výměna celých kol' }, id = object(spec).service_id;
  return Object.hasOwn(labels, id) ? labels[id] : 'Služba neuvedena';
}

export function vehicleLabel(spec) {
  const value = object(spec);
  const vehicles = { personal: 'Osobní', suv: 'MPV / SUV / 4×4', van: 'Dodávka' };
  const vehicle = Object.hasOwn(vehicles, value.vehicle_type) ? vehicles[value.vehicle_type] : '';
  const wheel = Number.isFinite(value.wheel_size_inches) && value.wheel_size_inches > 0 ? `${value.wheel_size_inches}″` : '';
  const rims = { steel: 'plechové disky', alu: 'alu disky' };
  const rim = Object.hasOwn(rims, value.rim_type) ? rims[value.rim_type] : '';
  return [vehicle, wheel, rim, value.runflat === true ? 'runflat' : '', value.tpms === true ? 'TPMS' : ''].filter(Boolean).join(' · ') || 'Vozidlo neuvedeno';
}

function instant(value) {
  if (value === '' || !(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function pragueDay(value = Date.now()) {
  const parsed = instant(value);
  if (!parsed) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(parsed);
  const part = name => parts.find(value => value.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dayLabel(value) {
  const parsed = instant(value);
  return parsed ? new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' }).format(parsed) : 'Neuvedeno';
}

export function timeLabel(value) {
  const parsed = instant(value);
  return parsed ? new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed) : 'Neuvedeno';
}

export function moneyLabel(minor) {
  return typeof minor === 'number' && Number.isSafeInteger(minor)
    ? new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 2 }).format(minor / 100) : 'Neuvedeno';
}

export function matchesSearch(query, valuesArray) {
  const normalized = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('cs-CZ');
  const haystack = (Array.isArray(valuesArray) ? valuesArray : []).map(normalized).join(' ');
  return normalized(query).trim().split(/\s+/).every(word => haystack.includes(word));
}

export function availableOrderActions(record, role, now = Date.now()) {
  if (!['owner', 'staff'].includes(role)) return [];
  const view = object(record), order = orderOf(record), intent = intentOf(record), observation = object(intent.observation);
  if (!order.id) return [];
  const actions = [], booking = object(view.booking), stripe = object(view.stripe_checkout);
  const terminal = ['cancelled', 'refunded', 'expired', 'service_completed'].includes(order.status);
  const cancellationPending = ['cancel_requested', 'refund_pending'].includes(order.status);
  if (!terminal && !cancellationPending && booking.status === 'confirmed' && instant(booking.start_at)?.getTime() > new Date(now).getTime()) {
    actions.push({ action: 'reschedule', label: 'Změnit termín', kind: 'secondary' });
  }
  const stripeBlocksCancel = stripe.state && !['expired', 'failed'].includes(stripe.state);
  const funded = [intent.state, observation.state].some(value => ['escrow_funded', 'result_submitted', 'seller_paid', 'refund_requested', 'refunded'].includes(value));
  if (!terminal && !cancellationPending && !stripeBlocksCancel && !funded
    && ['draft', 'awaiting_payment', 'owner_approval_required', 'confirmed', 'payment_failed', 'reconciliation_required'].includes(order.status)) {
    actions.push({ action: 'cancel', label: ['purchase_requested', 'reconciliation_required'].includes(intent.state) ? 'Požádat o storno' : 'Stornovat objednávku', kind: 'danger' });
  }
  if (role !== 'owner') return actions;
  if (!terminal && !cancellationPending && intent.provider === 'masumi' && ['purchase_requested', 'reconciliation_required'].includes(intent.state)) {
    actions.push({ action: 'resume-payment', label: 'Prověřit a obnovit platbu', kind: 'secondary' });
  }
  if (intent.provider === 'masumi' && observation.state === 'refund_requested' && intent.state !== 'refunded') {
    actions.push({ action: 'authorize-refund', label: 'Schválit ověřené vrácení', kind: 'danger' });
  }
  if (!['service_completed', 'refunded'].includes(order.status) && !stripeBlocksCancel && ['escrow_funded', 'result_submitted'].includes(observation.state)
    && !['refund_requested', 'refunded', 'seller_paid'].includes(intent.state)) {
    actions.push({ action: 'refund-request', label: 'Požádat o vrácení a stornovat', kind: 'danger' });
  }
  return actions;
}
