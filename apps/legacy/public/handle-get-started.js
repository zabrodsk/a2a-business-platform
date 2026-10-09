const nodes = [...document.querySelectorAll('[data-i18n]')];
const english = Object.fromEntries(nodes.map(node => [node.dataset.i18n, node.textContent]));
Object.assign(english, { copied: 'Copied. Paste these instructions into your agent’s chat.', failed: 'The instructions could not be loaded. Please try again.' });
const czech = {
  skip: 'Přejít k obsahu', console: 'Konzole majitele', kicker: 'ZAČÍNÁME', title: 'Váš agent. Ve spojení.', lead: 'Vyberte, kde chcete začít. Agent zajistí propojení; vy rozhodujete, co smí dělat.', demo: 'Demo Pneu 007 · simulované platby',
  businessLabel: 'PRO MAJITELE FIREM', businessTitle: 'Připojte svou firmu', businessLead: 'Předejte agentovi zadání. Připraví připojení, Agent Card a zápis do registru.',
  businessStep1: 'Zkopírujte prompt a předejte ho firemnímu agentovi. Přístupy k webu a systémům poskytněte bezpečným kanálem.', businessStep2: 'Otevřete jeho ověřovací odkaz. Potvrďte web a schvalte přístup agenta ve svém vlastním účtu Handle.', businessStep3: 'Posuďte navržená pravidla a povolte konkrétní práci a publikaci webu.', businessStep4: 'Agent ověří webhook, zveřejní schválenou kartu a ověří zápis v registru.',
  copyBusiness: 'Zkopírovat zadání pro firmu', openCard: 'Otevřít nastavení Agent Card', businessLimit: 'Tato instalace podporuje pouze web fiktivního Pneu 007. Libovolnou externí firmu zde zatím připojit nelze.',
  customerLabel: 'PRO ZÁKAZNÍKY', customerTitle: 'Najděte službu', customerLead: 'Jednou načtěte zákaznický skill. Dodá agentovi adresu registru i postup, jak kontaktovat firmu.',
  customerStep1: 'Vložte zákaznické instrukce do chatu s agentem. Pokud runtime umí trvalé skills, uložte je; jinak je načtěte v každém novém chatu.', customerStep2: 'Řekněte, jakou službu a v jaké lokalitě hledáte. Adresu webu firmy znát nemusíte.', customerStep3: 'Agent prohledá registr, načte aktuální Agent Card a požádá firemního agenta o nabídku.', customerStep4: 'Posuďte přesnou nabídku. Rezervaci nebo platbu schvalte teprve, když chcete pokračovat.',
  copyCustomer: 'Zkopírovat zákaznické instrukce', readSkill: 'Přečíst zákaznický skill', example: '„Najdi pneuservis v Holešovicích a požádej o nabídku. Zatím nerezervuj ani neplať.“', customerAccess: 'Veřejné hledání v registru nepotřebuje účet ani token. Ani aktuální veřejná demo konverzace nevyžaduje přihlášení. Jiné firemní služby mohou mít vlastní zákaznické ověření.',
  readyLabel: 'PŘED PŘIJÍMÁNÍM POŽADAVKŮ', readyTitle: 'Kdy je firma připravená?', readyLead: 'Nechte agenta ověřit každý krok. Samotná zveřejněná karta ani aktivní zápis v registru nedokazují, že dokáže odpovědět.',
  ready1: 'Agent má vlastní schválené připojení do Handle.', ready2: 'Schválili jste přesná provozní pravidla a oprávnění.', ready3: 'Skutečný webhook probudí agenta a ten odpoví.', ready4: 'Agent Card je veřejně dostupná a web na ni odkazuje.', ready5: 'Hledání v registru vrátí aktivní zápis firmy.', ready6: 'Samostatný zákaznický agent firmu objeví a dostane skutečnou odpověď.',
  accessTitle: 'Účty a soukromý přístup', accountTitle: 'První účet majitele', accountText: 'Pokud účet majitele ještě neexistuje, požádejte provozovatele této instalace Handle o aktivační kód. Zadejte ho sami v „První účet“. Pokud účet už máte, přihlaste se.', tokenTitle: 'Handle token vašeho agenta', tokenText: 'Po vašem schválení vydá Handle agentovi soukromý token. Agent jej bezpečně uloží. Nevkládáte ho na web, do Agent Card ani do zákaznického chatu. Pro případnou URL a klíč webhooku použijte bezpečná pole runtime.', registryTitle: 'Zveřejnění v registru', registryText: 'Provozovatel registru musí poskytnout samostatný publisher enrollment. Pokud agent tento přístup nemá, požádejte o něj provozovatele dema. Handle token nestačí ke zveřejnění zápisu v registru.',
  modesTitle: 'Plné nastavení, nebo připravené demo?', modesText: 'Firemní prompt výše provádí plné řízené nastavení: agent se zaregistruje, audituje zdroje a vyčká na vaše souhlasy. Připravené veřejné demo používá existující pravidla a data, takže neprokazuje nový audit. I zde má přednost ověřený webhook; opakované kontroly inboxu jsou podporovaná náhradní cesta.', preparedGuide: 'Instrukce připraveného dema pro agenty', footer: 'Pneu 007 je fiktivní. Žádná fyzická služba se neposkytuje. Demo používá místní simulaci platby; bez skutečných prostředků a blockchainových transakcí.', technicalGuide: 'Podrobný návod k nastavení',
  manualTitle: 'Zkopírujte instrukce', manualText: 'Kopírování do schránky není dostupné. Označte text a zkopírujte ho pomocí Ctrl+C nebo Cmd+C.', instructions: 'Instrukce pro vašeho agenta', close: 'Zavřít', copied: 'Zkopírováno. Vložte instrukce do chatu se svým agentem.', failed: 'Instrukce se nepodařilo načíst. Zkuste to znovu.',
};
let language = 'en';
try { language = localStorage.getItem('handle.lang') === 'cs' ? 'cs' : 'en'; } catch {}
const t = key => (language === 'cs' ? czech[key] : english[key]) || english[key];
function renderLanguage() {
  document.documentElement.lang = language;
  document.title = language === 'cs' ? 'Začínáme · Handle' : 'Get started · Handle';
  nodes.forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-lang]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === language)));
}
renderLanguage();
const status = document.querySelector('#copy-status');
const dialog = document.querySelector('#copy-dialog');
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.lang) {
    language = button.dataset.lang;
    try { localStorage.setItem('handle.lang', language); } catch {}
    status.hidden = true;
    renderLanguage();
    return;
  }
  if (!button.dataset.copy) return;
  button.disabled = true;
  status.hidden = true;
  try {
    const path = button.dataset.copy === 'business' ? '/handle/agent-card-prompt' : '/handle/customer-prompt';
    const response = await fetch(path, { credentials: 'omit', redirect: 'error', headers: { Accept: 'text/plain' } });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain')) throw new Error('Instructions unavailable');
    const text = (await response.text()).replaceAll('[WEBSITE_URL]', location.origin);
    if (!text.trim()) throw new Error('Empty instructions');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      status.className = 'hd-note hd-note-ok';
      status.textContent = t('copied');
      status.hidden = false;
    } catch {
      const input = dialog.querySelector('textarea');
      input.value = text;
      dialog.showModal();
      input.focus();
      input.select();
    }
  } catch {
    status.className = 'hd-note hd-note-bad';
    status.textContent = t('failed');
    status.hidden = false;
  } finally { button.disabled = false; }
});
dialog.addEventListener('close', () => { dialog.querySelector('textarea').value = ''; });
