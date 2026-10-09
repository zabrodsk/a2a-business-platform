import { BOOKING_CONFIG } from '../../../packages/demo-garage/index.js';
import { MAPPING_VERSION, PAYMENT_SKUS } from '../../../packages/payments/index.js';
import { loadProfile } from '../../relay/src/card.js';
import { renderCancellationPolicy } from './cancellation-policy.js';

export interface PublicDemoContext {
  publicUrl: string;
  networkFee?: string;
  simulation: boolean;
}
const publicPages = new Set(['index.html', 'kalkulator.html', 'kontakt.html', 'podminky.html', 'pro-agenty.html']);
export const hasPublicDemoContent = (file: string) => publicPages.has(file);
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function publicHeader(file: string): string {
  const link = (page: string, href: string, label: string) => `<a class="site-header-link" href="${href}"${file === page ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site-header">
    <nav class="site-header-primary" aria-label="Hlavní navigace">
      ${link('index.html', '/#sluzby', 'Služby')}
      ${link('kalkulator.html', '/kalkulator', 'Kalkulátor')}
    </nav>
    <a class="wm site-header-brand" href="/" aria-label="Pneu 007 — úvod"><span class="wm-a">Pneu</span><span class="wm-b">007</span></a>
    <div class="site-header-secondary">
      <nav aria-label="Další odkazy">
        ${link('kontakt.html', '/kontakt', 'Kontakt')}
        ${link('podminky.html', '/podminky', 'Podmínky')}
        ${link('', '/kalkulator', 'Objednat')}
      </nav>
      <div class="live-session"><button class="btn-q" type="button" data-live-login>Přihlásit se</button></div>
    </div>
  </header>`;
}
function ada(quantity: string): string {
  const value = BigInt(quantity), whole = (value / 1_000_000n).toLocaleString('cs-CZ');
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole},${fraction}` : whole;
}
const workshopPlan = `<svg viewBox="0 0 360 180" width="360" style="width:100%;max-width:360px;height:auto" aria-hidden="true">
  <rect x="8" y="137" width="344" height="35" rx="5" fill="#D8DAD4"/><text x="180" y="160" text-anchor="middle" fill="#2F3835" font-size="13">Agentova ulice · fiktivní plánek</text>
  <rect x="186" y="18" width="158" height="86" rx="6" fill="#071C17"/><text x="265" y="48" text-anchor="middle" fill="#D8C394" font-size="15">PNEU 007</text><rect x="210" y="64" width="110" height="40" fill="#F2F1EC"/><text x="265" y="89" text-anchor="middle" fill="#071C17" font-size="13">Servisní box</text>
  <rect x="16" y="32" width="60" height="67" rx="4" fill="#FFFFFF" stroke="#A88B47"/><rect x="86" y="32" width="60" height="67" rx="4" fill="#FFFFFF" stroke="#A88B47"/><text x="46" y="73" text-anchor="middle" fill="#071C17" font-size="22">P1</text><text x="116" y="73" text-anchor="middle" fill="#071C17" font-size="22">P2</text>
  <path d="M265 135V111" stroke="#8D7035" stroke-width="4"/><path d="M258 119L265 110L272 119" fill="none" stroke="#8D7035" stroke-width="3"/><text x="219" y="128" fill="#5A4A28" font-size="12">Vjezd</text>
</svg>`;

/** Render public demo copy; retain approved legacy template bytes as compatibility evidence.
 * This presentation is not a new audit or activation of operating policy. */
export function renderPublicDemoContent(file: string, template: string, context: PublicDemoContext): string {
  if (!hasPublicDemoContent(file)) return template;
  if (file === 'pro-agenty.html') {
    const payment = context.simulation
      ? 'Aktuální demo používá místní simulaci platby se zálohou 500 Kč. Žádné skutečné prostředky, blockchainové transakce ani fyzická služba.'
      : 'Masumi na Cardano Preprod používá testovací prostředky. Aktuální platební možnosti a schválení ověřte před potvrzením nabídky; žádná fyzická služba.';
    return template
      .replace('Začněte <a href="/agents.md">úplnými instrukcemi pro agenty</a>.', 'Začněte <a href="/handle/get-started">stručným průvodcem Handle pro majitele a zákazníky</a>. Technické <a href="/agents.md">instrukce pro agenty</a> jsou dostupné zvlášť.')
      .replace('Záloha 500 Kč, nebo plná úhrada přes Masumi na síti Cardano Preprod. Bez skutečné služby.', payment)
      .replace('e-mail, telefon, provozovna (povinné); jméno', 'V aktuální veřejné demo konverzaci není vyžadován zákaznický účet ani e-mail. Jiný režim může vyžadovat vlastní ověření.')
      .replace('záloha, nebo plná úhrada, je-li povolená', context.simulation ? 'simulovaná záloha 500 Kč podle schválené nabídky' : 'jen skutečně podporovaná a schválená testovací platební metoda')
      .replace('Platby na mainnetu nebo v korunách', context.simulation ? 'Skutečné platby, blockchainové transakce a reálné služby' : 'Platby na mainnetu a reálné služby')
      .replace('Rezervace platí až po ověření platby.', 'Rezervaci potvrďte až podle uloženého stavu objednávky a platby; nabídka sama není rezervace.');
  }
  const profile = loadProfile('pneu007');
  let html = template.replace(/<header\b[^>]*>[\s\S]*?<\/header>/, publicHeader(file));
  const fill = (label: string, value: string) => { html = html.replace(`<span class="ph">${label}</span>`, escape(value)); };
  if (file === 'index.html') {
    fill('[PLACEHOLDER]', `${profile.site.phone} · nefunkční demo číslo`);
    html = html.replace('Bez runflat a TPMS · upřesníte v kalkulátoru', '');
  }
  if (file === 'kontakt.html') {
    fill('[PLACEHOLDER: testovací adresa]', profile.location!.address);
    fill('[PLACEHOLDER: telefon]', `${profile.site.phone} · nefunkční demo číslo`);
    fill('[PLACEHOLDER: nasazená URL]', context.publicUrl);
    fill('[PLACEHOLDER: hodiny]', `${String(BOOKING_CONFIG.opening_hour).padStart(2, '0')}:00–${String(BOOKING_CONFIG.closing_hour).padStart(2, '0')}:00`);
    fill('[PLACEHOLDER: hodiny]', 'Zavřeno'); fill('[PLACEHOLDER: hodiny]', 'Zavřeno');
    fill('[PLACEHOLDER]', 'Vjezd z Agentovy ulice, dvě parkovací stání P1 a P2 před boxem 007 (fiktivní orientace).');
    fill('[PLACEHOLDER]', 'Demo zastávka „Agentova“, linka 007; přibližně 3 minuty pěšky (fiktivní spojení).');
    html = html.replace('<span class="ph">[PLACEHOLDER: orientační plánek]</span>', workshopPlan)
      .replace('aria-label="Místo pro orientační plánek, mapa se nezobrazuje"', 'aria-label="Fiktivní plánek: Agentova ulice, dvě parkovací stání a vjezd do servisního boxu"')
      .replace('Hodiny nejsou potvrzené. Doplní provozovatel.', 'Ukázková provozní doba podle testovacího rezervačního systému.')
      .replace('Živou mapu nezobrazujeme. Nejde o skutečnou provozovnu.', 'Ukázkový plánek není skutečná mapa. Na této fiktivní adrese se služby neposkytují.');
  }
  if (file === 'podminky.html') {
    const deposit = PAYMENT_SKUS.find(sku => sku.payment_mode === 'deposit' && sku.amount_minor === BOOKING_CONFIG.deposit_minor)!;
    const unit = context.simulation ? 'simulovaných ADA' : 'test-ADA';
    fill('[PLACEHOLDER: doplní provozovatel]', 'Doplatek evidujeme u objednávky. V této ukázce se samostatně neinkasuje; po záloze jej vidíte v souhrnu rezervace.');
    fill('[PLACEHOLDER: demo mapování]', `${BOOKING_CONFIG.deposit_minor / 100} Kč → ${ada(deposit.asset_quantity)} ${unit} (${MAPPING_VERSION}; syntetické mapování, nikoli směnný kurz)`);
    fill('[PLACEHOLDER]', context.networkFee ? `výchozí maximální rozpočet ${ada(context.networkFee)} ${unit}; konkrétní limit schválíte před platbou, skutečný poplatek určí síť` : 'maximální rozpočet zobrazíme před potvrzením platby');
    html = html.replace('Přepočet Kč → test-ADA:', 'Demo mapování pro Masumi:')
      .replace('· síťový poplatek:', '· rozpočet síťového poplatku:')
      .replace('Platby probíhají přes Masumi na síti Cardano Preprod v test-ADA. Nejde o platbu v korunách.', `${context.simulation ? 'Toto prostředí používá lokální simulaci plateb.' : 'Masumi zpracovává blockchainové transakce na Cardano Preprod v test-ADA.'} Volitelný Link / karta používá samostatnou testovací platbu v Kč. Dostupné metody uvidíte před autorizací.`)
      .replace('Shrnutí pravidel pro objednání u fiktivního pneuservisu Pneu 007. Právní znění storna a refundu doplní provozovatel.', 'Podmínky objednání, změny termínu a vrácení platby za služby Pneu 007.')
      .replace('Storno a refund</a>', 'Storno a vrácení platby</a>')
      .replace('<strong>Testnet platba, bez skutečné autoservisní služby.</strong>', `<strong>${context.simulation ? 'Lokální platební režim.' : 'Masumi · Cardano Preprod.'}</strong>`)
      .replace(/<section id="storno"[^>]*>[\s\S]*?<\/section>/, renderCancellationPolicy());
  }
  return html;
}
