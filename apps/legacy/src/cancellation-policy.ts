import { readFileSync } from 'node:fs';

export interface CancellationPolicy {
  schema_version: string;
  policy_id: string;
  version: string;
  effective_from: string;
  business: string;
  fictional_business: boolean;
  authority: { kind: string; description: string; rulebook_activation: boolean };
  cancellation: {
    scope: string;
    changes_allowed: boolean;
    change_fee_minor: number;
    cancellation_fee_minor: number;
    recommended_notice_hours: number;
    recommended_notice_is_condition: boolean;
    late_cancellation_fee_minor: number;
    no_show_fee_minor: number;
    shop_cancellation_refund_percent: number;
    request_channel: string;
    effective_when: string;
    completed_service: string;
    changes_subject_to: string;
  };
  refund: {
    unperformed_service_percent: number;
    late_cancellation_percent: number;
    no_show_percent: number;
    amount_basis: string;
    include_unpaid_balance: boolean;
    include_spent_network_fees: boolean;
    default_destination: string;
    alternative_compensation: string;
    fiat_conversion_for_test_assets: boolean;
    acknowledgement_business_days: number;
    owner_action_business_days: number;
    owner_action_starts_after: string[];
    owner_action: string;
    unconfirmed_refund_follow_up_business_days: number;
    follow_up_starts_after: string;
    deadline_kind: string;
    funds_arrival_deadline_guaranteed: boolean;
    business_calendar: { weekdays: number[]; timezone: string; description: string };
    unknown_original_payment: string;
    completion_evidence_any_of: string[];
  };
  payment_routes: {
    masumi: {
      network: string;
      asset: string;
      refund_window: string;
      after_payout_or_closed_window: string;
      test_asset_has_fiat_refund_value: boolean;
      technical_window_is_shop_cancellation_deadline: boolean;
    };
    stripe_link: { refund_execution: string; automatic_refund_tracking_in_legacy: boolean };
  };
  implementation_notes: {
    policy_is_not_automated_capability: boolean;
    automatic_deadline_scheduler: boolean;
    agent_refund_authority: boolean;
    agent_allowed_actions: string[];
    manual_compensation_is_not_provider_refund: boolean;
    pending_request_is_not_completed_refund: boolean;
    new_rulebook_requires_separate_human_approval: boolean;
  };
}

/** Published merchant terms; this source does not activate or amend a rulebook. */
export const CANCELLATION_POLICY: CancellationPolicy = JSON.parse(
  readFileSync(new URL('../public/cancellation-policy.json', import.meta.url), 'utf8'),
);

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Customer copy stays readable; provider limitations remain available for audit. */
export function renderCancellationPolicy(): string {
  const { cancellation, refund, payment_routes } = CANCELLATION_POLICY;
  return `<section id="storno" style="display:flex;flex-direction:column;gap:16px">
    <h2 class="serif" style="font-size:34px">Změna termínu, storno a vrácení platby</h2>
    <p class="pretty"><strong>Neprovedenou službu můžete změnit nebo zrušit zdarma.</strong> Dejte nám prosím vědět ideálně alespoň ${cancellation.recommended_notice_hours} hodin před termínem. Jde o doporučení: ani při pozdějším zrušení nebo nedostavení se neúčtujeme storno poplatek.</p>
    <ul style="display:grid;gap:10px">
      <li><strong>Jak požádat:</strong> kontaktujte obsluhu a uveďte číslo objednávky. Storno platí, jakmile je zaznamenáme a potvrdíme. Nový termín musí obsluha potvrdit podle volné kapacity.</li>
      <li><strong>Kolik vracíme:</strong> při zrušení neprovedené služby vracíme ${refund.unperformed_service_percent} % skutečně zaplacené zálohy nebo ceny služby, i při pozdním stornu nebo nedostavení se. Nezaplacený doplatek se nevrací; již spotřebované síťové poplatky se nevracejí.</li>
      <li><strong>Když termín zrušíme my:</strong> nabídneme jiný termín, nebo vrátíme ${cancellation.shop_cancellation_refund_percent} % uhrazené zálohy či ceny služby, podle vaší volby.</li>
      <li><strong>Po provedení služby:</strong> dokončenou práci již nelze stornovat. Případnou reklamaci posoudí majitel a domluví s vámi řešení.</li>
    </ul>
    <div style="border:1px solid #D8DAD4;padding:20px;display:flex;flex-direction:column;gap:10px">
      <h3 style="font-size:18px">Kdy vyřídíme vrácení platby</h3>
      <p>Žádost potvrdíme nejpozději do ${refund.acknowledgement_business_days} pracovního dne. Jakmile přijmeme storno a ověříme původní platbu, majitel do ${refund.owner_action_business_days} pracovních dnů zahájí její vrácení, nebo s vámi domluví ruční kompenzaci. Vracíme stejnou měnu či platební prostředek, kterým byla služba uhrazena; jiný způsob vyžaduje dohodu s majitelem.</p>
      <p>Tyto lhůty určují naši reakci, nikoli okamžik připsání prostředků. Pokud poskytovatel nepotvrdí vrácení do ${refund.unconfirmed_refund_follow_up_business_days} pracovních dnů od jeho zahájení, majitel stav prověří a sdělí vám další postup.</p>
      <p class="small mute">${escape(refund.business_calendar.description)}</p>
    </div>
    <details class="faq" style="border-top:1px solid #D8DAD4;border-bottom:1px solid #D8DAD4;padding:12px 0">
      <summary style="min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:600">Podrobnosti podle platební metody</summary>
      <div style="display:flex;flex-direction:column;gap:12px;padding:8px 0">
        <p><strong>Masumi:</strong> platbu v ${escape(payment_routes.masumi.asset)} na síti ${escape(payment_routes.masumi.network)} vracíme v ${escape(payment_routes.masumi.asset)}, nikoli v korunách. Před žádostí ověříme dostupné refund okno poskytovatele včetně údaje <code>unlockTime</code>, je-li uveden. Toto technické okno může skončit dříve než termín služby. Po výplatě nebo uzavření okna majitel domluví ruční kompenzaci ve stejných testovacích prostředcích; váš nárok ze storna tím nezaniká.</p>
        <p><strong>Link / karta:</strong> pokud byla tato metoda použita, vrácení zadává majitel ručně u platebního poskytovatele. Vrácení probíhá mimo automatický proces rezervace; jeho potvrzení vám předá obsluha.</p>
        <p><strong>Nejasný stav platby:</strong> nejprve dohledáme původní transakci. Neplaťte znovu. Požadavek ani časový limit nejsou dokladem vrácení; dokončení potvrzuje poskytovatel nebo ověřený doklad o skutečné kompenzaci.</p>
        <p><strong>Obsluha agentem:</strong> agent může vysvětlit pravidla, zkontrolovat stav a předat požadavek majiteli. Sám nerozhoduje o refundu ani neposílá kompenzaci. Uvedené lhůty plní obsluha; nejde o automatický proces.</p>
      </div>
    </details>
    <p class="small mute">Pravidla fiktivního Pneu 007 · účinnost ${escape(CANCELLATION_POLICY.effective_from)} · <a href="/cancellation-policy.json">Pravidla pro agenty, verze ${escape(CANCELLATION_POLICY.version)} (JSON)</a></p>
  </section>`;
}
