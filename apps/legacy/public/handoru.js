// Handle owner console. Plain-language, Czech/English. Every action calls the same owner API as before.
const API = '/api/handle/v1';
const AUDIT_SCOPES = ['audit.read', 'audit.propose', 'questions.create', 'relay.provision', 'context.read'];
const OPERATION_SCOPES = ['inbox.claim', 'inbox.reply', 'cases.quote', 'orders.checkout', 'registry.publish', 'website.agent-card.publish'];
const TABS = ['get-started', 'overview', 'audit', 'rules', 'agents', 'website', 'handover'];
const PAID = ['escrow_funded', 'result_submitted', 'seller_paid'];

const I18N = {
  cs: {
    skip: 'Přejít k obsahu', console: 'Konzole majitele', manage: 'Správa firmy', footer: 'Majitel rozhoduje. Agent pracuje v mezích pravidel.',
    openWeb: 'Otevřít web firmy', guide: 'Návod k prvnímu dni', getStarted: 'Začínáme', sandbox: 'Sandbox', refresh: 'Obnovit', logout: 'Odhlásit', language: 'Jazyk', business: 'Firma',
    tabs: { 'get-started': 'Začínáme', overview: 'Přehled', audit: 'Audit a otázky', rules: 'Pravidla', agents: 'Agenti a přístupy', website: 'Agent Card', handover: 'Předání firmy' },
    leads: { 'get-started': 'Připojte firemního agenta nebo najděte službu přes A2A.', overview: 'Co se ve firmě děje a co čeká na vaše rozhodnutí.', audit: 'Co agent zjistil o vaší firmě a na co se vás ptá.', rules: 'Co agent smí udělat sám, co jen s vaším souhlasem a co nikdy.', agents: 'Kdo pro vás pracuje a co smí dělat.', website: 'Jak zákaznické agenty najdou vašeho agenta na webu.', handover: 'Výměna agenta bez ztráty zákazníků a rozpracované práce.' },
    footNote: 'Sandbox · skutečné provozní a platební stavy se ověřují v jejich zdrojových systémech.',
    start: {
      businessTitle: 'Připojte svou firmu', businessText: 'Předejte zadání firemnímu agentovi. Připraví připojení, Agent Card a zápis v registru.',
      businessSteps: ['Zkopírujte prompt a bezpečně poskytněte přístup k webu a systémům.', 'Otevřete ověřovací odkaz od agenta, potvrďte web a schvalte jeho přístup ve vlastním účtu Handle.', 'Posuďte audit a přesnou verzi navržených pravidel. Povolte konkrétní práci a publikaci.', 'Agent ověří webhook, zveřejní schválenou kartu a ověří zápis v registru.'],
      customerTitle: 'Najděte službu', customerText: 'Zákaznický skill dodá agentovi adresu registru i postup, jak kontaktovat firmu.',
      customerSteps: ['Zkopírujte instrukce do chatu s agentem. Skill uložte, pokud to runtime podporuje; jinak ho načtěte v každém novém chatu.', 'Řekněte, jakou službu a v jaké lokalitě hledáte. Agent prohledá registr a načte aktuální Agent Card.', 'Posuďte nabídku. Rezervaci nebo platbu povolte až po svém rozhodnutí.'],
      copyCustomer: 'Zkopírovat zákaznické instrukce', example: 'Najdi pneuservis v Holešovicích a požádej o nabídku. Zatím nerezervuj ani neplať.',
      limit: 'Tato instalace podporuje pouze fiktivní Pneu 007. Libovolnou externí firmu zde zatím připojit nelze. Platby v tomto demu jsou místní simulace.',
      accessTitle: 'Účty a soukromý přístup', access: ['První účet: aktivační kód poskytne provozovatel této instalace. Pokud účet už máte, přihlaste se.', 'Po vašem souhlasu vydá Handle agentovi vlastní soukromý token. Agent jej bezpečně uloží; nepatří do karty ani běžného chatu. Pro URL a klíč webhooku použijte bezpečná pole runtime.', 'Pro zápis do registru potřebuje agent samostatný publisher enrollment od provozovatele registru. Handle token jej nenahrazuje.'],
      readyTitle: 'Kdy je firma připravená?', readyText: 'Nechte agenta doložit každý krok. Toto je checklist pro ověření, nikoli potvrzení aktuálního stavu.',
      ready: ['Agent má vlastní schválené připojení a pravidla.', 'Skutečný webhook jej probudí a agent odpoví.', 'Karta je veřejná a web na ni odkazuje.', 'Registr vrací aktivní zápis firmy.', 'Samostatný zákaznický agent firmu objeví a dostane odpověď.'],
      modesTitle: 'Plné nastavení a připravené demo', modesText: 'Firemní prompt provádí řízené nastavení s auditem a vašimi souhlasy. Připravené veřejné demo používá existující pravidla a data; není důkazem nového auditu. Hledání v registru a aktuální veřejná demo konverzace nepotřebují zákaznický token.',
    },
    // login
    loginTitle1: 'Váš business.', loginTitle2: 'Vaše', loginTitle3: 'pravidla.', loginLead: 'Váš agent prozkoumá firmu a navrhne pravidla. Vy rozhodujete, co smí dělat.',
    modeLogin: 'Přihlásit se', modeSignup: 'První účet', email: 'E-mail', password: 'Heslo', newPassword: 'Nové heslo · aspoň 12 znaků', setupCode: 'Aktivační kód', setupHint: 'O aktivační kód požádejte provozovatele této instalace Handle. Není to vaše heslo.',
    signIn: 'Přihlásit do Handle', createAccount: 'Vytvořit účet',
    noPassword: 'Heslo nepředávejte svému agentovi.', requestOpened: 'Otevřeli jste žádost agenta o připojení. Po přihlášení ji uvidíte. Samotný odkaz nic neschvaluje.',
    // generic
    techDetails: 'Technické detaily', none: 'Žádné', yes: 'Ano', no: 'Ne', notSet: 'Neuvedeno', review: 'Zkontrolovat', open: 'Otevřít', save: 'Uložit', approve: 'Schválit', reject: 'Zamítnout', cancel: 'Zavřít',
    saved: 'Uloženo.', noBusiness: 'Firma ještě není připojena', noBusinessText: 'Pošlete svému agentovi adresu vašeho webu. Agent se sám zaregistruje a tady vám ukáže žádost s šestimístným kódem.',
    // overview
    nextStep: 'Nejbližší krok', waitingForYou: 'Čeká na vás', nothingWaiting: 'Nic nečeká na vaše rozhodnutí.', agentWorking: 'Pracuje váš agent',
    steps: ['Připojení', 'Schránka zpráv', 'Audit', 'Pravidla', 'Na webu'], stepsD: ['Schválili jste agenta', 'Agent má kam přijímat zprávy', 'Agent poznal firmu', 'Vy jste schválili pravidla', 'Zákazníci agenta najdou'],
    kConversations: 'Konverzace', kQuotes: 'Nabídky', kBookings: 'Rezervace', kValue: 'Hodnota rezervací', kExceptions: 'Výjimky ke schválení', kRules: 'Platná pravidla',
    kConversationsD: 'zákaznických případů', kQuotesD: 'vydaných nabídek', kBookingsD: (n) => `${n} zaplaceno`, kValueD: 'součet rezervací', kExceptionsD: 'slevy nad limit agenta', kRulesD: (v) => v ? `verze ${v}` : 'zatím žádná',
    chartTitle: 'Nabídky a rezervace · 14 dní', chartQuotes: 'Nabídky', chartBookings: 'Rezervace', chartEmpty: 'Zatím žádné zákaznické konverzace.',
    funnel: 'Od konverzace k zakázce', fConv: 'Konverzace', fQuote: 'Nabídka', fAccepted: 'Přijatá nabídka', fPaid: 'Zaplaceno',
    discounts: 'Slevy v nabídkách', dNone: 'Bez slevy', dAuto: 'Agent sám', dOwner: 'S vaším souhlasem', dBlocked: 'Zakázáno',
    next: {
      request: ['Schvalte připojení agenta', 'Váš agent žádá o přístup. Zkontrolujte kód, který vám ukázal.'],
      relay: ['Agent si zřizuje schránku pro zprávy', 'Nemusíte nic dělat. Agent si sám připraví, kam mu budou chodit zprávy.'],
      audit: ['Agent zkoumá vaši firmu', 'Prochází web, administraci a dokumenty. Výsledky a otázky uvidíte v Auditu.'],
      questions: ['Odpovězte agentovi na otázky', 'Bez vašich odpovědí nemůže agent navrhnout přesná pravidla.'],
      proposal: ['Agent ještě připravuje návrh pravidel', 'Jakmile návrh pošle, uvidíte ho v Pravidlech.'],
      activate: ['Zkontrolujte a schvalte pravidla', 'Agent navrhl, co smí dělat sám. Platí to až po vašem schválení.'],
      approvals: ['Rozhodněte o cenové výjimce', 'Agent chce dát slevu nad svůj limit a čeká na vás.'],
      grant: ['Povolte agentovi obsluhovat zákazníky', 'Pravidla platí. Teď určete, co konkrétně smí agent dělat.'],
      probe: ['Agent potvrzuje, že zná nová pravidla', 'Krátká kontrola na straně agenta. Pak mu můžete povolit práci.'],
      website: ['Agent zveřejní kontakt na webu', 'Povolte mu zveřejnění, ať ho zákaznické agenty najdou.'],
      done: ['Vše běží', 'Agent pracuje podle vašich pravidel. Sledujte, co čeká na vás.'],
    },
    // requests
    requestTitle: (r) => `${r} žádá o připojení`, validUntil: 'Platí do', requestFrom: 'Agent', website: 'Web', codeLabel: 'Kód od agenta', codePh: '6 číslic',
    wantsTo: 'Agent chce', confirmAgent: 'Ověřil/a jsem, že jde o mého agenta a moji firmu.', confirmAgentHint: 'Tímto agent nemůže nakupovat ani nic zveřejnit.', approveConnection: 'Schválit připojení',
    // audit
    auditEmpty: 'Agent zatím audit neposlal', auditEmptyText: 'Agent prochází váš web, administraci, dokumenty a existující nástroje. Nic za něj nevyplňujeme.',
    sSystems: 'Systémy', sEvidence: 'Důkazy', sAnswered: 'Zodpovězené otázky', sFindings: 'K pozornosti', version: (v) => `Verze ${v}`,
    question: 'Otázka pro vás', critical: 'Blokuje pravidla', yourAnswer: 'Vaše odpověď', answerPh: 'Napište odpověď vlastními slovy.',
    kindPolicy: 'Moje rozhodnutí', kindPolicySub: 'Určuji, jak to má být', kindFact: 'Fakt ke kontrole', kindFactSub: 'Agent ověří ve zdroji', answerType: 'Co to je',
    scope: 'Na co se to vztahuje', scopeDefault: 'Celá firma, běžný provoz', until: 'Platí do · volitelné', saveAnswer: 'Uložit odpověď', updateAnswer: 'Upravit odpověď',
    systemsTitle: 'Systémy, které agent prošel', colSystem: 'Systém', colAuthority: 'Je zdrojem pravdy pro', colAccess: 'Jak agent přistupoval', colRoles: 'Účty',
    findingsTitle: 'Co agent zjistil', answeredTitle: 'Zodpovězeno', kindPolicyShort: 'Rozhodnutí', kindFactShort: 'Fakt', evidenceTitle: 'Důkazy', noFindings: 'Bez zvláštních zjištění.',
    sev: { info: 'Informace', warning: 'Pozor', critical: 'Kritické' },
    // rules
    rulesEmpty: 'Zatím žádný návrh pravidel', rulesEmptyText: 'Agent navrhne pravidla po auditu. Nic se nepředvyplňuje.',
    sActive: 'Platí', sProposal: 'Návrh čeká', sApprovals: 'Výjimky čekají', sDeposit: 'Záloha',
    proposalTitle: (v) => `Návrh pravidel · verze ${v}`, waitsForYou: 'Čeká na vás', whatChanges: 'Co se změní', firstRules: 'Takhle by agent pracoval',
    allRules: 'Všechna pravidla návrhu', blockedQuestions: 'Návrh obsahuje nezodpovězené kritické otázky. Odpovězte v Auditu a agent pošle opravený návrh.',
    blockedParameters: 'Návrh má blokované parametry. Agent musí vyřešit uvedené auditní blokace a poslat opravený návrh; váš souhlas je sám neodstraní.',
    blockedFallback: 'Agent musí doplnit chybějící podklady nebo vyřešit auditní blokace a poslat opravený návrh.',
    blockedFindings: 'Kritická zjištění', blockedParameterList: 'Blokované parametry', findingRule: 'Návrh pravidel', findingReport: (v) => `Audit · verze ${v}`,
    confirmRules: 'Přečetl/a jsem si pravidla a souhlasím s nimi.', activate: (v) => `Schválit pravidla (verze ${v})`,
    activeTitle: (v) => `Vaše platná pravidla · verze ${v}`, activeSince: (d) => `Platí od ${d}`, barAuto: 'agent sám', barOwner: 's vámi', barLimit: 'limit',
    exceptionsTitle: 'Cenové výjimky', colOffer: 'Nabídka', colDiscount: 'Sleva', colTotal: 'Cena', colState: 'Stav', noExceptions: 'Žádné výjimky.',
    olderVersions: 'Starší verze', param: 'Parametr', value: 'Hodnota',
    // approval dialog
    scopes: { 'audit.read': 'Číst audit a firemní podklady', 'audit.propose': 'Navrhovat audit a pravidla', 'questions.create': 'Klást vám otázky', 'relay.provision': 'Zřídit firemní schránku pro zprávy', 'context.read': 'Číst firemní kontext a historii', 'inbox.claim': 'Přebírat konverzace se zákazníky', 'inbox.reply': 'Odpovídat zákazníkům', 'cases.quote': 'Vydávat cenové nabídky', 'orders.checkout': 'Dokončit objednávku a platbu', 'registry.publish': 'Zapsat firmu do registru agentů', 'website.agent-card.publish': 'Zveřejnit kontakt pro agenty na webu' },
    rule: { services: (v) => `Agent nabízí jen: ${v}.`, auto: (v) => `Slevu do ${v} smí agent dát sám.`, owner: (v) => `Slevu do ${v} smí dát jen s vaším schválením.`, hard: (v) => `Slevu nad ${v} nedá nikdy.`, ttl: (v) => `Nabídka platí ${v} minut.`, deposit: (v) => `Záloha při rezervaci je ${v}.`, extrasYes: 'Smí přidávat doplňkové služby.', extrasNo: 'Žádné doplňkové služby navíc.', currency: (v) => `Ceny jsou v ${v}.`, masumi: (v) => `Platby jdou přes Masumi (${v}).`, simulated: 'Platby jsou jen zkušební (simulace).', suppliers: (v) => `Dodavatelům smí jen: ${v}.`, and: ' a ' },
    verify: { required: 'Nejdřív ověřte, že web patří vám. Přihlásíte se do administrace webu a povolíte jednorázové ověření. Teprve potom schválíte agenta.', verified: 'Web je ověřený. Teď porovnejte kód od agenta a schvalte přístup.', notRequired: 'Web už je ověřený pro váš účet. Porovnejte kód a schvalte přístup.', stale: 'Tuto žádost už nelze schválit. Agent ji musí obnovit a poslat nový odkaz.', button: 'Ověřit web Pneu', check: 'Zkontrolovat ověření', title: 'Ověřit web', text: 'Přihlašujete se do administrace webu, ne do Handle. Heslo jde jen webu; agent ho nedostane.', note: 'Ověření platí jen pro tuto žádost. Agenta schválíte zvlášť.', user: 'Uživatelské jméno správce webu', pass: 'Heslo do administrace webu', already: 'V prohlížeči už jste přihlášeni jako správce webu.', allow: 'Povoluji zveřejnit jednorázové ověření tohoto webu pro tuto žádost.', submit: 'Ověřit web', done: 'Web je ověřený. Teď porovnejte kód a schvalte agenta.', doneBefore: 'Web už je ověřený. Můžete schválit agenta.', badLogin: 'Přihlášení do administrace se nepodařilo. Zkontrolujte jméno a heslo.', needOwner: 'Ověření potřebuje přihlášení správce webu.', wrongSite: 'Tento web nelze ověřit přihlášením do jeho administrace.', mismatch: 'Veřejné ověření zatím nesedí. Zkuste to znovu.', notReady: 'Žádost už není připravená ke schválení. Obnovte stránku.' },
    lines: { tyre_change: 'Přezutí pneumatik', wheel_swap: 'Výměna kompletních kol', personal: 'Osobní auto', suv: 'SUV', van: 'Dodávka', steel: 'Plechové disky', alu: 'Hliníkové disky', diameter: 'Velikost kol', runflat: 'Run-flat pneumatiky', tpms: 'Senzory tlaku (TPMS)' }, wheels: (n, d) => `${n} kola · ${d}″`,
    exceptionKicker: (v) => `Cenová výjimka · pravidla v${v}`, exceptionTitle: (p) => `Schválit slevu ${p}?`, total: 'Celkem', case: 'Služba', slot: 'Termín', expires: 'Vyprší', deposit: 'Záloha',
    confirmException: 'Rozhoduji jen o této nabídce a této ceně.', approveException: 'Schválit výjimku', expired: 'Nabídka vypršela. Agent musí připravit novou.', discountLine: (p) => `Sleva ${p}`,
    // agents
    colAgent: 'Agent', colWorking: 'Pracuje pro vás', colReady: 'Zná platná pravidla', colPerms: 'Oprávnění', agentsEmpty: 'Zatím žádný připojený agent.',
    permsTitle: (r) => `${r} · co smí dělat`, setupPerms: 'Nastavení a audit', workPerms: 'Práce se zákazníky', confirmPerms: 'Povoluji vybrané činnosti v mezích platných pravidel.', savePerms: 'Uložit oprávnění',
    readyOk: 'Agent potvrdil, že zná platná pravidla.', readyMissing: 'Agent ještě nepotvrdil, že zná platná pravidla. Do té doby mu nejde povolit práci se zákazníky.', needsRules: 'Nejdřív schvalte pravidla.',
    revokeTitle: 'Odpojit agenta', revokeText: 'Agent okamžitě ztratí přístup do Handle. Účty, které jste mu dali jinde (např. admin webu), zrušte i tam.', confirmRevoke: 'Chci tohoto agenta odpojit.', revoke: 'Odpojit agenta', revokedNote: 'Agent je odpojen. Nový agent se musí připojit znovu.',
    // website
    webTitle: 'Propojte svůj web s agenty', webText: 'Agent Card říká ostatním agentům, co vaše firma nabízí a jak kontaktovat vašeho agenta. Zkopírujte prompt a předejte ho svému agentovi. Provede vás nastavením a po vašem schválení kartu zveřejní na webu.',
    copyPrompt: 'Zkopírovat prompt', promptCopied: 'Prompt zkopírován. Předejte ho svému agentovi.', promptLoadError: 'Prompt se nepodařilo načíst. Zkuste to znovu.', promptManualTitle: 'Zkopírujte prompt ručně', promptManualText: 'Prohlížeč nepovolil kopírování do schránky. Označte text a zkopírujte ho pomocí Ctrl+C nebo ⌘C.', selectPrompt: 'Označit celý prompt', publicationDetails: 'Stav a historie zveřejnění',
    cRules: 'Pravidla schválena', cGrant: 'Agent smí zveřejnit kontakt', cCheck: 'Kontakt ověřen pro platná pravidla', cCard: 'Karta agenta',
    okActive: 'Ano', missing: 'Chybí', waiting: 'Čeká', published: 'Zveřejněno', viewCard: 'Zobrazit kartu', grantPublish: 'Povolit zveřejnění',
    revisions: 'Historie zveřejnění', colRevision: 'Zveřejnění', colChecked: 'Ověřeno', noRevisions: 'Agent zatím nic nezveřejnil.',
    webNext: ['Povolte agentovi zveřejnit kontakt', 'V Agenti a přístupy zaškrtněte „Zveřejnit kontakt pro agenty na webu“.'],
    webNextAgent: ['Agent zveřejní kontakt', 'Má povolení. Jakmile kartu zveřejní, Handle ji ověří.'],
    // handover
    hOpen: 'Otevřené případy', hValue: 'Rozpracováno', hAgents: 'Připojení agenti', hSaved: 'Uložená předání',
    hFlow: ['Agent A pracuje', 'Agent B připojen', 'B zná pravidla', 'Přístupy A zrušeny', 'Potvrzeno'],
    casesTitle: 'Rozpracované případy', colCase: 'Případ', colPayment: 'Platba', noCases: 'Žádné rozpracované případy.',
    legacyTitle: 'Zrušit agentovi A přístup do administrace webu', legacyText: 'Odpojení v Handle neodhlásí agenta z administrace vašeho webu. Tady změníte heslo účtu, který měl agent A, a odhlásíte všechna jeho přihlášení.',
    legacyAccount: 'Účet, který měl agent A', chooseAccount: 'Vyberte účet…', legacyOwner: 'owner · správa webu', legacyStaff: 'staff · obsluha', confirmLegacy: 'Změnit heslo a odhlásit tento účet.', rotate: 'Změnit heslo a odhlásit',
    prepTitle: 'Předat práci novému agentovi', prepNeeds: 'K předání potřebujete: platná pravidla, pracujícího agenta A a dalšího připojeného agenta B.',
    fromA: 'A · teď pracuje', toB: 'B · převezme práci', chooseB: 'Vyberte agenta…', noProof: ' · ještě nepotvrdil pravidla',
    accessTitle: 'Přístupy agenta A v jiných systémech', accessState: 'Stav', accessEvidence: 'Jak jste to ověřili', accessPh: 'Kdo, kdy a kde přístup zrušil. Žádná hesla.',
    stPending: 'Ještě nezrušeno', stRevoked: 'Zrušeno a ověřeno', stUncertain: 'Nejistý zápis, nejdřív dohledat', nativeOnly: 'Agent A měl jen přístup přes Handle. Jinde žádný přístup nezůstal.',
    confirmHandover: 'Zkontroloval/a jsem oba agenty, platná pravidla, otevřené případy a přístupy.', prepare: 'Připravit předání',
    savedTitle: 'Uložená předání', noHandoffs: 'Zatím žádné předání.', confirmCommit: 'Potvrzuji předání. Agent B převezme případy, agent A přijde o oprávnění.', commit: 'Potvrdit předání', notFinished: 'Předání čeká na zrušení přístupů. Pak připravte nové.',
    passwordTitle: 'Nové heslo · zobrazí se jen jednou', passwordText: 'Heslo si bezpečně uložte. Nedávejte ho původnímu agentovi ani do chatu.', newPw: 'Nové heslo', showHide: 'Zobrazit / skrýt', done: 'Hotovo, smazat z obrazovky',
    // messages
    msg: { login: 'Přihlášeno.', signup: 'Účet vytvořen.', logout: 'Odhlášeno.', consentOk: 'Auditní připojení schváleno. Agent si teď sám dokončí nastavení.', consentNo: 'Žádost zamítnuta.', answer: 'Odpověď uložena. Agent ji zapracuje do pravidel.', activate: (v) => `Pravidla verze ${v} platí.`, approvalOk: 'Výjimka schválena.', approvalNo: 'Výjimka zamítnuta.', grant: 'Oprávnění uložena.', revoke: 'Agent odpojen. Přístupy mimo Handle zrušte zvlášť.', legacy: (u) => `Heslo účtu ${u} změněno, přihlášení zrušena.`, handover: 'Předání připraveno. Zkontrolujte ho a potvrďte.', handoverBlocked: 'Předání uloženo, ale čeká na zrušení přístupů.', commit: 'Předání dokončeno.', rejectNeedsCode: 'Pro zamítnutí zadejte kód od agenta.', gone: 'Firma už není dostupná. Obnovte stránku.' },
    errors: { OWNER_SETUP_REQUIRED: 'Aktivační kód chybí nebo nesedí.', OWNER_EXISTS: 'První účet už existuje. Přihlaste se.', INVALID_LOGIN: 'Nesprávný e-mail nebo heslo.', INVALID_ACCOUNT: 'Zadejte platný e-mail a heslo aspoň 12 znaků.', PAIRING_CODE_INVALID: 'Kód nesedí. Zkontrolujte ho u agenta.', ONBOARDING_UNAVAILABLE: 'Žádost vypršela nebo už byla vyřízena.', OWNERSHIP_PROOF_REQUIRED: 'Nejdřív ověřte web tlačítkem „Ověřit web“, pak schvalte agenta.', RULEBOOK_HASH_MISMATCH: 'Pravidla se mezitím změnila. Obnovte stránku.', CAPABILITY_REQUIRED: 'Agent ještě nepotvrdil, že zvládne tuto práci.', STALE_EXECUTION: 'Stav se mezitím změnil. Obnovte stránku.', HUMAN_REQUIRED: 'Přihlaste se znovu.', CSRF_REQUIRED: 'Platnost stránky vypršela. Obnovte ji.' },
    states: { active: 'Aktivní', proposed: 'Návrh', superseded: 'Nahrazeno', pending: 'Čeká', approved: 'Schváleno', rejected: 'Zamítnuto', revoked: 'Odpojen', suspended: 'Pozastaven', audit_only: 'Jen audit', ready: 'Připraveno', prepared: 'Připraveno k potvrzení', committed: 'Předáno', published: 'Zveřejněno', verified: 'Ověřeno', written: 'Zapsáno', withdrawal_pending: 'Stahuje se', open: 'Otevřený', quoted: 'Nabídnuto', awaiting_owner: 'Čeká na vás', recommended: 'Doporučeno', accepted: 'Přijato', created: 'Vytvořeno', purchase_requested: 'Čeká na platbu', escrow_funded: 'Zaplaceno', result_submitted: 'Zaplaceno', seller_paid: 'Vyplaceno', refunded: 'Vráceno', failed: 'Selhalo', reconciliation_required: 'Dohledat', revocation_pending: 'Ještě nezrušeno', verified_revoked: 'Zrušeno', uncertain_write: 'Nejistý zápis', pending_external_revocation: 'Čeká na zrušení přístupů', external_access_revocation_pending: 'Čeká na zrušení přístupů' },
  },
  en: {
    skip: 'Skip to content', console: 'Owner console', manage: 'Run the business', footer: 'You decide. Your agent works within your rules.',
    openWeb: 'Open the business website', guide: 'First-day guide', getStarted: 'Get started', sandbox: 'Sandbox', refresh: 'Refresh', logout: 'Sign out', language: 'Language', business: 'Business',
    tabs: { 'get-started': 'Get started', overview: 'Overview', audit: 'Audit & questions', rules: 'Rules', agents: 'Agents & access', website: 'Agent Card', handover: 'Handover' },
    leads: { 'get-started': 'Connect your business agent or find a service through A2A.', overview: 'What is happening in your business and what needs your decision.', audit: 'What your agent learned about your business, and its questions for you.', rules: 'What the agent may do on its own, only with your approval, or never.', agents: 'Who works for you and what they may do.', website: 'How customer agents find your agent on your website.', handover: 'Swap agents without losing customers or work in progress.' },
    footNote: 'Sandbox · real operational and payment states are confirmed in their source systems.',
    start: {
      businessTitle: 'Connect your business', businessText: 'Give the setup prompt to your business agent. It prepares the connection, Agent Card and registry listing.',
      businessSteps: ['Copy the prompt and securely supply website and system access.', 'Open the agent’s verification link, confirm your website and approve its access in your own Handle account.', 'Review the audit and exact proposed rules. Allow the specific work and website publication.', 'The agent tests its webhook, publishes the approved card and verifies the registry listing.'],
      customerTitle: 'Find a service', customerText: 'The customer skill supplies the registry address and the steps to contact a business.',
      customerSteps: ['Copy the instructions into your agent’s chat. Save the skill if your runtime supports it; otherwise load it in each new chat.', 'Ask for a service and area. Your agent searches the registry and reads the current Agent Card.', 'Review the offer. Approve a booking or payment only when you want to proceed.'],
      copyCustomer: 'Copy customer instructions', example: 'Find a tyre service in Holešovice and ask for a quote. Do not book or pay.',
      limit: 'This installation supports fictional Pneu 007 only. Arbitrary external businesses are not supported here yet. Payments in this demo use local simulation.',
      accessTitle: 'Accounts and private access', access: ['First account: get an activation code from the person running this installation. If you already have an account, sign in.', 'After your consent, Handle issues the agent’s own private token. The agent stores it securely; it does not belong in the card or ordinary chat. Use the runtime’s secure fields for a webhook URL/key.', 'Registry publication needs separate publisher enrollment from the registry operator. A Handle token cannot replace it.'],
      readyTitle: 'When is the business ready?', readyText: 'Ask your agent to provide evidence for each step. This is a verification checklist, not a statement of current status.',
      ready: ['The agent has its own approved connection and operating rules.', 'A real webhook wakes the agent and it replies.', 'The card is public and the website links to it.', 'The registry returns an active business listing.', 'A separate customer agent discovers the business and receives an answer.'],
      modesTitle: 'Full setup and the prepared demo', modesText: 'The business prompt performs managed setup with an audit and your approvals. The prepared public demo uses existing rules and records; it does not prove a fresh audit. Registry search and the current public demo conversation need no customer token.',
    },
    loginTitle1: 'Your business.', loginTitle2: 'Your', loginTitle3: 'rules.', loginLead: 'Your agent studies the business and proposes rules. You decide what it may do.',
    modeLogin: 'Sign in', modeSignup: 'First account', email: 'Email', password: 'Password', newPassword: 'New password · at least 12 characters', setupCode: 'Activation code', setupHint: 'Ask the person running this Handle installation for an activation code. It is not your password.',
    signIn: 'Sign in to Handle', createAccount: 'Create account',
    noPassword: 'Never give your password to your agent.', requestOpened: 'You opened an agent connection request. You will see it after signing in. The link itself approves nothing.',
    techDetails: 'Technical details', none: 'None', yes: 'Yes', no: 'No', notSet: 'Not set', review: 'Review', open: 'Open', save: 'Save', approve: 'Approve', reject: 'Reject', cancel: 'Close',
    saved: 'Saved.', noBusiness: 'No business connected yet', noBusinessText: 'Send your agent your website address. It registers itself and shows you a request with a six-digit code here.',
    nextStep: 'Next step', waitingForYou: 'Waiting for you', nothingWaiting: 'Nothing needs your decision.', agentWorking: 'Your agent is on it',
    steps: ['Connected', 'Message inbox', 'Audit', 'Rules', 'On the website'], stepsD: ['You approved the agent', 'The agent can receive messages', 'The agent knows the business', 'You approved the rules', 'Customers can find the agent'],
    kConversations: 'Conversations', kQuotes: 'Quotes', kBookings: 'Bookings', kValue: 'Booking value', kExceptions: 'Exceptions to decide', kRules: 'Rules in force',
    kConversationsD: 'customer cases', kQuotesD: 'quotes sent', kBookingsD: (n) => `${n} paid`, kValueD: 'total of bookings', kExceptionsD: 'discounts above the agent limit', kRulesD: (v) => v ? `version ${v}` : 'none yet',
    chartTitle: 'Quotes and bookings · 14 days', chartQuotes: 'Quotes', chartBookings: 'Bookings', chartEmpty: 'No customer conversations yet.',
    funnel: 'From conversation to job', fConv: 'Conversations', fQuote: 'Quote', fAccepted: 'Quote accepted', fPaid: 'Paid',
    discounts: 'Discounts in quotes', dNone: 'No discount', dAuto: 'Agent alone', dOwner: 'With your approval', dBlocked: 'Not allowed',
    next: {
      request: ['Approve your agent\'s connection', 'Your agent is asking for access. Check the code it showed you.'],
      relay: ['Your agent is setting up its message inbox', 'Nothing to do. The agent prepares where its messages arrive.'],
      audit: ['Your agent is studying the business', 'It goes through the website, admin and documents. Results and questions appear under Audit.'],
      questions: ['Answer your agent\'s questions', 'Without your answers the agent cannot propose exact rules.'],
      proposal: ['Your agent is preparing the rules', 'Once it sends a proposal, you will see it under Rules.'],
      activate: ['Review and approve the rules', 'The agent proposed what it may do on its own. Nothing applies until you approve.'],
      approvals: ['Decide a price exception', 'The agent wants to give a discount above its limit and is waiting for you.'],
      grant: ['Let your agent serve customers', 'The rules are in force. Now choose what exactly the agent may do.'],
      probe: ['Your agent is confirming the new rules', 'A short check on the agent side. Then you can let it work.'],
      website: ['Your agent publishes its contact on the website', 'Allow publishing so customer agents can find it.'],
      done: ['All running', 'Your agent works within your rules. Keep an eye on what waits for you.'],
    },
    requestTitle: (r) => `${r} asks to connect`, validUntil: 'Valid until', requestFrom: 'Agent', website: 'Website', codeLabel: 'Code from your agent', codePh: '6 digits',
    wantsTo: 'The agent wants to', confirmAgent: 'I checked this is my agent and my business.', confirmAgentHint: 'This does not let the agent buy or publish anything.', approveConnection: 'Approve connection',
    auditEmpty: 'No audit from your agent yet', auditEmptyText: 'Your agent is going through your website, admin, documents and existing tools. Nothing is pre-filled for it.',
    sSystems: 'Systems', sEvidence: 'Evidence', sAnswered: 'Questions answered', sFindings: 'Needs attention', version: (v) => `Version ${v}`,
    question: 'A question for you', critical: 'Blocks the rules', yourAnswer: 'Your answer', answerPh: 'Answer in your own words.',
    kindPolicy: 'My decision', kindPolicySub: 'I decide how it should be', kindFact: 'A fact to check', kindFactSub: 'The agent verifies it at the source', answerType: 'What is it',
    scope: 'What it applies to', scopeDefault: 'Whole business, normal operation', until: 'Valid until · optional', saveAnswer: 'Save answer', updateAnswer: 'Update answer',
    systemsTitle: 'Systems your agent went through', colSystem: 'System', colAuthority: 'Source of truth for', colAccess: 'How the agent accessed it', colRoles: 'Accounts',
    findingsTitle: 'What the agent found', answeredTitle: 'Answered', kindPolicyShort: 'Decision', kindFactShort: 'Fact', evidenceTitle: 'Evidence', noFindings: 'Nothing unusual.',
    sev: { info: 'Info', warning: 'Attention', critical: 'Critical' },
    rulesEmpty: 'No rules proposed yet', rulesEmptyText: 'Your agent proposes rules after the audit. Nothing is pre-filled.',
    sActive: 'In force', sProposal: 'Proposal waiting', sApprovals: 'Exceptions waiting', sDeposit: 'Deposit',
    proposalTitle: (v) => `Proposed rules · version ${v}`, waitsForYou: 'Waiting for you', whatChanges: 'What changes', firstRules: 'This is how your agent would work',
    allRules: 'All proposed rules', blockedQuestions: 'The proposal has unanswered critical questions. Answer under Audit and the agent will send a corrected proposal.',
    blockedParameters: 'The proposal has blocked parameters. The agent must resolve the listed audit blockers and submit a corrected proposal; your approval alone cannot remove them.',
    blockedFallback: 'The agent must supply missing evidence or resolve audit blockers and submit a corrected proposal.',
    blockedFindings: 'Critical findings', blockedParameterList: 'Blocked parameters', findingRule: 'Rule proposal', findingReport: (v) => `Audit · version ${v}`,
    confirmRules: 'I read the rules and agree with them.', activate: (v) => `Approve the rules (version ${v})`,
    activeTitle: (v) => `Your rules in force · version ${v}`, activeSince: (d) => `In force since ${d}`, barAuto: 'agent alone', barOwner: 'with you', barLimit: 'limit',
    exceptionsTitle: 'Price exceptions', colOffer: 'Quote', colDiscount: 'Discount', colTotal: 'Price', colState: 'Status', noExceptions: 'No exceptions.',
    olderVersions: 'Older versions', param: 'Parameter', value: 'Value',
    scopes: { 'audit.read': 'Read the audit and business records', 'audit.propose': 'Propose the audit and rules', 'questions.create': 'Ask you questions', 'relay.provision': 'Set up the business message inbox', 'context.read': 'Read business context and history', 'inbox.claim': 'Take customer conversations', 'inbox.reply': 'Reply to customers', 'cases.quote': 'Send price quotes', 'orders.checkout': 'Complete orders and payment', 'registry.publish': 'List the business in the agent registry', 'website.agent-card.publish': 'Publish the agent contact on the website' },
    rule: { services: (v) => `The agent offers only: ${v}.`, auto: (v) => `The agent may give a discount of up to ${v} on its own.`, owner: (v) => `Discounts up to ${v} need your approval first.`, hard: (v) => `Never a discount above ${v}.`, ttl: (v) => `An offer stays valid for ${v} minutes.`, deposit: (v) => `The booking deposit is ${v}.`, extrasYes: 'Extra services are allowed.', extrasNo: 'No extra services on top.', currency: (v) => `Prices are in ${v}.`, masumi: (v) => `Payments go through Masumi (${v}).`, simulated: 'Payments are test-only (simulation).', suppliers: (v) => `With suppliers it may only: ${v}.`, and: ' and ' },
    verify: { required: 'First confirm the website is yours. You sign in to the website admin and allow a one-time check. Only then you approve the agent.', verified: 'The website is verified. Now compare the code from your agent and approve access.', notRequired: 'The website is already verified for your account. Compare the code and approve access.', stale: 'This request can no longer be approved. The agent must renew it and send a new link.', button: 'Verify website', check: 'Check verification', title: 'Verify website', text: 'You are signing in to the website admin, not to Handle. The password goes only to the website; the agent never gets it.', note: 'The check applies only to this request. You approve the agent separately.', user: 'Website admin username', pass: 'Website admin password', already: 'You are already signed in as the website admin in this browser.', allow: 'I allow publishing a one-time verification of this website for this request.', submit: 'Verify website', done: 'The website is verified. Now compare the code and approve the agent.', doneBefore: 'The website is already verified. You can approve the agent.', badLogin: 'Website admin sign-in failed. Check the username and password.', needOwner: 'Verification needs the website admin sign-in.', wrongSite: 'This website cannot be verified through its admin sign-in.', mismatch: 'The public verification does not match yet. Try again.', notReady: 'The request is no longer ready for approval. Refresh the page.' },
    lines: { tyre_change: 'Tyre change', wheel_swap: 'Wheel swap', personal: 'Passenger car', suv: 'SUV', van: 'Van', steel: 'Steel rims', alu: 'Alloy rims', diameter: 'Wheel size', runflat: 'Run-flat tyres', tpms: 'Pressure sensors (TPMS)' }, wheels: (n, d) => `${n} wheels · ${d}″`,
    exceptionKicker: (v) => `Price exception · rules v${v}`, exceptionTitle: (p) => `Approve this ${p} discount?`, total: 'Total', case: 'Service', slot: 'Slot', expires: 'Expires', deposit: 'Deposit',
    confirmException: 'I am deciding only this quote and this price.', approveException: 'Approve exception', expired: 'The quote expired. The agent has to prepare a new one.', discountLine: (p) => `Discount ${p}`,
    colAgent: 'Agent', colWorking: 'Works for you', colReady: 'Knows current rules', colPerms: 'Permissions', agentsEmpty: 'No agent connected yet.',
    permsTitle: (r) => `${r} · what it may do`, setupPerms: 'Setup and audit', workPerms: 'Working with customers', confirmPerms: 'I allow the selected work within the rules in force.', savePerms: 'Save permissions',
    readyOk: 'The agent confirmed it knows the rules in force.', readyMissing: 'The agent has not yet confirmed it knows the rules in force. Until then you cannot let it work with customers.', needsRules: 'Approve the rules first.',
    revokeTitle: 'Disconnect the agent', revokeText: 'The agent loses Handle access at once. Accounts you gave it elsewhere (e.g. website admin) must be removed there too.', confirmRevoke: 'I want to disconnect this agent.', revoke: 'Disconnect agent', revokedNote: 'This agent is disconnected. A new agent must connect again.',
    webTitle: 'Connect your website with agents', webText: 'An Agent Card tells other agents what your business offers and how to contact your agent. Copy the prompt and give it to your agent. It will guide you through setup and publish the card on your website after your approval.',
    copyPrompt: 'Copy prompt', promptCopied: 'Prompt copied. Give it to your agent.', promptLoadError: 'The prompt could not be loaded. Please try again.', promptManualTitle: 'Copy the prompt manually', promptManualText: 'Your browser did not allow clipboard access. Select the text and copy it with Ctrl+C or ⌘C.', selectPrompt: 'Select the whole prompt', publicationDetails: 'Publication status and history',
    cRules: 'Rules approved', cGrant: 'Agent may publish the contact', cCheck: 'Contact verified for the rules in force', cCard: 'Agent card',
    okActive: 'Yes', missing: 'Missing', waiting: 'Waiting', published: 'Published', viewCard: 'View card', grantPublish: 'Allow publishing',
    revisions: 'Publishing history', colRevision: 'Publication', colChecked: 'Verified', noRevisions: 'Nothing published yet.',
    webNext: ['Let your agent publish its contact', 'Under Agents & access, tick “Publish the agent contact on the website”.'],
    webNextAgent: ['Your agent publishes its contact', 'It is allowed to. Once it publishes the card, Handle verifies it.'],
    hOpen: 'Open cases', hValue: 'In progress', hAgents: 'Connected agents', hSaved: 'Saved handovers',
    hFlow: ['Agent A working', 'Agent B connected', 'B knows the rules', 'A\'s access removed', 'Confirmed'],
    casesTitle: 'Cases in progress', colCase: 'Case', colPayment: 'Payment', noCases: 'No cases in progress.',
    legacyTitle: 'Remove agent A from your website admin', legacyText: 'Disconnecting in Handle does not sign the agent out of your website admin. Here you change the password of the account agent A had and end all its sessions.',
    legacyAccount: 'The account agent A had', chooseAccount: 'Choose an account…', legacyOwner: 'owner · website admin', legacyStaff: 'staff · front desk', confirmLegacy: 'Change the password and sign this account out.', rotate: 'Change password and sign out',
    prepTitle: 'Hand the work to a new agent', prepNeeds: 'A handover needs: rules in force, a working agent A and another connected agent B.',
    fromA: 'A · working now', toB: 'B · takes over', chooseB: 'Choose an agent…', noProof: ' · has not confirmed the rules',
    accessTitle: 'Agent A\'s access in other systems', accessState: 'Status', accessEvidence: 'How you checked', accessPh: 'Who removed the access, when and where. No passwords.',
    stPending: 'Not removed yet', stRevoked: 'Removed and checked', stUncertain: 'Uncertain change, trace it first', nativeOnly: 'Agent A only had access through Handle. No access remains elsewhere.',
    confirmHandover: 'I checked both agents, the rules in force, open cases and access.', prepare: 'Prepare handover',
    savedTitle: 'Saved handovers', noHandoffs: 'No handovers yet.', confirmCommit: 'I confirm the handover. Agent B takes over the cases, agent A loses its permissions.', commit: 'Confirm handover', notFinished: 'Handover waits for access removal. Then prepare a new one.',
    passwordTitle: 'New password · shown only once', passwordText: 'Store it safely. Do not give it to the old agent or paste it into chat.', newPw: 'New password', showHide: 'Show / hide', done: 'Done, clear it from screen',
    msg: { login: 'Signed in.', signup: 'Account created.', logout: 'Signed out.', consentOk: 'Audit connection approved. Your agent will finish its setup itself.', consentNo: 'Request rejected.', answer: 'Answer saved. The agent will work it into the rules.', activate: (v) => `Rules version ${v} are in force.`, approvalOk: 'Exception approved.', approvalNo: 'Exception rejected.', grant: 'Permissions saved.', revoke: 'Agent disconnected. Remove access outside Handle separately.', legacy: (u) => `Password of ${u} changed, sessions ended.`, handover: 'Handover prepared. Review it and confirm.', handoverBlocked: 'Handover saved, but it waits for access removal.', commit: 'Handover complete.', rejectNeedsCode: 'Enter the code from your agent to reject.', gone: 'The business is no longer available. Refresh the page.' },
    errors: { OWNER_SETUP_REQUIRED: 'The activation code is missing or wrong.', OWNER_EXISTS: 'The first account already exists. Sign in.', INVALID_LOGIN: 'Wrong email or password.', INVALID_ACCOUNT: 'Use a valid email and a password of at least 12 characters.', PAIRING_CODE_INVALID: 'The code does not match. Check it with your agent.', ONBOARDING_UNAVAILABLE: 'The request expired or was already handled.', OWNERSHIP_PROOF_REQUIRED: 'First verify the website with “Verify website”, then approve the agent.', RULEBOOK_HASH_MISMATCH: 'The rules changed meanwhile. Refresh the page.', CAPABILITY_REQUIRED: 'The agent has not confirmed it can do this work yet.', STALE_EXECUTION: 'Things changed meanwhile. Refresh the page.', HUMAN_REQUIRED: 'Please sign in again.', CSRF_REQUIRED: 'This page expired. Refresh it.' },
    states: { active: 'Active', proposed: 'Proposed', superseded: 'Replaced', pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', revoked: 'Disconnected', suspended: 'Paused', audit_only: 'Audit only', ready: 'Ready', prepared: 'Ready to confirm', committed: 'Handed over', published: 'Published', verified: 'Verified', written: 'Written', withdrawal_pending: 'Being removed', open: 'Open', quoted: 'Quoted', awaiting_owner: 'Waiting for you', recommended: 'Recommended', accepted: 'Accepted', created: 'Created', purchase_requested: 'Awaiting payment', escrow_funded: 'Paid', result_submitted: 'Paid', seller_paid: 'Paid out', refunded: 'Refunded', failed: 'Failed', reconciliation_required: 'To trace', revocation_pending: 'Not removed yet', verified_revoked: 'Removed', uncertain_write: 'Uncertain change', pending_external_revocation: 'Waiting for access removal', external_access_revocation_pending: 'Waiting for access removal' },
  },
};
const TONES = { active: 'ok', approved: 'ok', ready: 'ok', published: 'ok', verified: 'ok', committed: 'ok', verified_revoked: 'ok', accepted: 'ok', escrow_funded: 'ok', result_submitted: 'ok', seller_paid: 'ok', written: 'info', revoked: 'bad', rejected: 'bad', suspended: 'bad', failed: 'bad', pending: 'escalation', awaiting_owner: 'escalation', proposed: 'wait', prepared: 'wait', quoted: 'info', open: 'neutral', superseded: 'neutral', uncertain_write: 'warn', revocation_pending: 'warn', reconciliation_required: 'warn' };
const GLYPH = { ok: '✓', warn: '!', wait: '…', bad: '×', info: 'i', neutral: '–', escalation: '◆', owner: '★' };

const params = new URLSearchParams(location.search);
const requestedId = params.get('request');
const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } } };
const state = {
  lang: ['cs', 'en'].includes(params.get('lang')) ? params.get('lang') : ['cs', 'en'].includes(storage.get('handle.lang')) ? storage.get('handle.lang') : 'cs',
  owner: null, csrf: '', dashboard: { businesses: [], requests: [] }, businessId: '',
  tab: TABS.includes((location.hash || '').slice(1)) ? location.hash.slice(1) : requestedId ? 'agents' : 'overview', authMode: 'login', busy: false, feedback: null, auditVersion: null, loaded: false,
};
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');

// ---------- helpers ----------
const L = () => I18N[state.lang];
const t = (key, ...args) => { const value = key.split('.').reduce((node, part) => node?.[part], L()); return typeof value === 'function' ? value(...args) : value ?? key; };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const list = value => Array.isArray(value) ? value : [];
function parsed(value, fallback = {}) { if (value && typeof value === 'object') return value; try { return JSON.parse(value) ?? fallback; } catch { return fallback; } }
const record = value => ({ ...parsed(value?.payload_json), ...parsed(value?.payload), ...value });
const locale = () => state.lang === 'cs' ? 'cs-CZ' : 'en-GB';
const money = minor => Number.isSafeInteger(minor) ? new Intl.NumberFormat(locale(), { style: 'currency', currency: 'CZK' }).format(minor / 100) : t('notSet');
const pct = bps => Number.isFinite(bps) ? `${(bps / 100).toLocaleString(locale())} %` : t('notSet');
const date = value => { if (!value) return t('notSet'); const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(d.getTime()) ? t('notSet') : d.toLocaleString(locale(), { timeZone: 'Europe/Prague', dateStyle: 'medium', timeStyle: 'short' }); };
const stateLabel = value => t(`states.${value}`) === `states.${value}` ? (value || t('notSet')) : t(`states.${value}`);
const chip = (value, tone = TONES[value] || 'neutral', label = stateLabel(value)) => `<span class="hd-chip hd-chip-${tone}"><span class="hd-chip-g" aria-hidden="true">${GLYPH[tone] || '–'}</span>${esc(label)}</span>`;
const ref = value => `<span class="hd-ref">${esc(value)}</span>`;
const meta = items => `<dl class="hd-meta">${items.filter(Boolean).map(([label, value, mono]) => `<dt>${esc(label)}</dt><dd${mono ? ' class="is-mono"' : ''}>${value ?? esc(t('notSet'))}</dd>`).join('')}</dl>`;
const tech = (...parts) => `<details class="hc-tech"><summary>${esc(t('techDetails'))}</summary><div>${parts.filter(Boolean).join('')}</div></details>`;
const pre = value => `<pre class="hc-pre">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
const scopeLabel = scope => L().scopes[scope] || scope;
const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const ARROW = icon('<path d="M5 12h14M13 6l6 6-6 6"></path>');
const NOTE_ICON = { info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.5"></path>', warn: '<path d="M12 3l10 18H2z"></path><path d="M12 10v4M12 17v.5"></path>', bad: '<circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path>', ok: '<circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.5 2.5L16 9.5"></path>' };
const note = (tone, html) => `<div class="hd-note hd-note-${tone}"${tone === 'bad' ? ' role="alert"' : ''}>${icon(NOTE_ICON[tone] || NOTE_ICON.info)}<div>${html}</div></div>`;
const button = (label, { variant = 'primary', size = '', attrs = '', arrow = false, type = 'button' } = {}) => `<button type="${type}" class="hd-btn hd-btn-${variant}${size ? ` hd-btn-${size}` : ''}" ${attrs}>${esc(label)}${arrow ? ARROW : ''}</button>`;
const check = (name, label, hint = '', extra = 'required') => `<label class="hd-check"><input type="checkbox" name="${name}" ${extra}><span>${esc(label)}${hint ? `<span class="hd-hint" style="font-family:var(--font-sans)">${esc(hint)}</span>` : ''}</span></label>`;
const field = (label, input, hint = '') => `<label class="hd-field"><span class="hd-lbl">${esc(label)}</span>${hint ? `<span class="hd-hint">${esc(hint)}</span>` : ''}${input}</label>`;
const stat = (label, value, detail = '', meter) => `<div class="hc-stat"><span class="hc-stat-l">${esc(label)}</span><span class="hc-stat-v">${esc(value)}</span>${meter !== undefined ? `<div class="hc-meter"><div style="width:${Math.max(0, Math.min(100, meter))}%"></div></div>` : ''}${detail ? `<span class="hc-stat-d">${esc(detail)}</span>` : ''}</div>`;
const panel = (title, body, { sub = '', extra = '', cls = '' } = {}) => `<section class="hc-panel ${cls}">${title ? `<div class="hc-panel-h"><h2>${title}</h2>${sub}</div>` : ''}${body}${extra}</section>`;
const table = (heads, rows, empty) => rows.length ? `<div class="hd-tscroll"><table class="hd-tbl"><thead><tr>${heads.map(([label, cls]) => `<th scope="col"${cls ? ` class="${cls}"` : ''}>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="hc-empty">${esc(empty)}</p>`;
function safeUrl(value) { try { const url = new URL(value, location.origin); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''; for (const key of [...url.searchParams.keys()]) if (/token|secret|password|key|code|credential|session/i.test(key)) url.searchParams.set(key, '[hidden]'); return url.href; } catch { return ''; } }
const link = (value, label = value) => { const url = safeUrl(value); return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : esc(label || t('notSet')); };
const runtimeName = value => value?.runtime || t('colAgent');
const lineLabel = label => L().lines[label] || label;
const serviceText = spec => spec ? [lineLabel(spec.service_id), lineLabel(spec.vehicle_type), t('wheels', spec.wheel_count ?? 4, spec.wheel_size_inches ?? '?')].join(' · ') : t('notSet');

// ---------- derived business data ----------
const business = () => list(state.dashboard.businesses).find(value => value.id === state.businessId);
const connectionScopes = value => list(value?.scopes ?? parsed(value?.scopes_json, []));
const readiness = value => parsed(value?.ready ?? value?.readiness ?? value?.ready_json, null);
const rulebooks = b => list(b?.rulebooks).map(record).sort((x, y) => y.version - x.version);
const activeRules = b => rulebooks(b).find(rule => rule.status === 'active');
const proposals = b => rulebooks(b).filter(rule => rule.status === 'proposed');
// One plain sentence per approved parameter; unknown parameters are shown verbatim, never dropped.
function describeRules(params = {}) {
  const r = L().rule, minutes = Number.isFinite(params.offer_ttl_seconds) ? Math.round(params.offer_ttl_seconds / 60) : '?';
  const known = { allowed_services: () => r.services(list(params.allowed_services).map(service => lineLabel(service).toLocaleLowerCase(locale())).join(r.and)), auto_discount_bps: () => r.auto(pct(params.auto_discount_bps)), owner_approval_limit_bps: () => r.owner(pct(params.owner_approval_limit_bps)), hard_discount_limit_bps: () => r.hard(pct(params.hard_discount_limit_bps)), offer_ttl_seconds: () => r.ttl(minutes), deposit_minor: () => r.deposit(money(params.deposit_minor)), allow_extras: () => params.allow_extras ? r.extrasYes : r.extrasNo, currency: () => r.currency(params.currency), provider: () => params.provider === 'masumi' ? r.masumi(params.network) : r.simulated, supplier_allowed_actions: () => r.suppliers(list(params.supplier_allowed_actions).join(', ')), network: null, asset: null };
  return Object.keys(params).flatMap(key => key in known ? (known[key] ? [{ key, text: known[key]() }] : []) : [{ key, text: `${key}: ${JSON.stringify(params[key])}` }]);
}
function describeChanges(from, to = {}) {
  if (!from) return [];
  const before = new Map(describeRules(from).map(line => [line.key, line.text]));
  return describeRules(to).filter(line => JSON.stringify(from[line.key]) !== JSON.stringify(to[line.key])).map(line => ({ before: before.get(line.key), after: line.text }));
}
const reports = b => list(b?.reports).map(record).map(report => ({ ...report, answers: list(b?.answers).filter(answer => answer.report_version === report.version), evidence: list(b?.evidence).filter(source => list(report.systems).some(system => system.id === source.capture?.system_id)) })).sort((x, y) => y.version - x.version);
const answerFor = (report, question) => list(report.answers).filter(answer => answer.question_id === question.id).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
const openQuestions = b => { const latest = reports(b)[0]; return latest ? list(latest.questions).filter(question => !answerFor(latest, question)).map(question => ({ ...question, report: latest })) : []; };
const pendingApprovals = b => list(b?.approvals).filter(approval => approval.status === 'pending');
const pendingRequests = () => list(state.dashboard.requests).filter(request => request.state === 'pending');
const proofCurrent = (b, connection) => { const proof = readiness(connection), rule = activeRules(b); return Boolean(proof?.probe_passed === true && rule && proof.rulebook_hash === rule.payload_hash); };
const currentPublication = b => { const rule = activeRules(b); return b?.active_connection_id && rule ? list(b.publications).find(item => ['published', 'verified'].includes(item.state) && item.rulebook_hash === rule.payload_hash) : undefined; };
const publishGrant = b => list(b?.connections).some(c => c.id === b?.active_connection_id && connectionScopes(c).includes('website.agent-card.publish'));
const cases = b => list(b?.cases);
const isPaid = item => list(item.payment).some(payment => PAID.includes(payment.state));

function nextStep(b) {
  const pick = (key, tab, owner = true) => ({ key, tab, owner, title: t(`next.${key}`)[0], text: t(`next.${key}`)[1] });
  if (pendingRequests().length) return pick('request', 'agents');
  if (!b) return null;
  if (!b.relay) return pick('relay', 'agents', false);
  if (!reports(b).length) return pick('audit', 'audit', false);
  if (openQuestions(b).length) return pick('questions', 'audit');
  if (proposals(b).length) return pick('activate', 'rules');
  if (!activeRules(b)) return pick('proposal', 'rules', false);
  if (pendingApprovals(b).length) return pick('approvals', 'rules');
  const active = list(b.connections).find(c => c.id === b.active_connection_id);
  if (!active) { const candidate = list(b.connections).find(c => !['revoked', 'suspended'].includes(c.state)); return candidate && proofCurrent(b, candidate) ? pick('grant', 'agents') : pick('probe', 'agents', false); }
  if (!currentPublication(b)) return publishGrant(b) ? { ...pick('website', 'website', false), title: t('webNextAgent')[0], text: t('webNextAgent')[1] } : pick('website', 'website');
  return pick('done', 'overview', false);
}

// ---------- API ----------
async function api(path, body) {
  const response = await fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error?.code || data.code || `HTTP_${response.status}`;
    const friendly = I18N[state.lang].errors[code];
    const error = new Error(friendly || `${data.error?.message || data.message || (typeof data.error === 'string' ? data.error : 'Request failed.')} (${code})`);
    error.status = response.status; error.code = code; throw error;
  }
  return data;
}
async function load() {
  try {
    const session = await api('/owner/session');
    state.owner = session.owner; state.csrf = session.csrf_token || '';
    if (state.owner) {
      state.dashboard = await api('/owner/dashboard');
      if (!business()) state.businessId = list(state.dashboard.businesses)[0]?.id || '';
      if (requestedId && !list(state.dashboard.requests).some(value => value.id === requestedId)) {
        try { const request = await api(`/owner/onboarding/${encodeURIComponent(requestedId)}`); if (request?.state === 'pending') state.dashboard.requests = [...list(state.dashboard.requests), request]; } catch { /* expired or foreign request */ }
      }
    }
  } catch (error) { if (error.status === 401) { state.owner = null; state.csrf = ''; } else state.feedback = { tone: 'bad', text: error.message }; }
  state.loaded = true; render();
}

// ---------- shell ----------
const WORDMARK = `<svg class="hd-wm-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="none" stroke-width="5" stroke-linejoin="miter" stroke-miterlimit="10"><path d="M20 21.5V9l4-4h16l4 4v12.5" stroke="var(--ink-muted)"></path><path d="M5 27l24.5-11.5M59 27L34.5 15.5" stroke="var(--ink-muted)"></path><path d="M5 27l27 34 27-34" stroke="currentColor"></path></g><path d="M29.5 23h5l1 20-3.5 4-3.5-4z" fill="currentColor"></path></svg>`;
const wordmark = (tagline = false) => `<a class="hd-wm" href="/handle" aria-label="Handle">${WORDMARK}<span aria-hidden="true">Handle</span>${tagline ? '<span class="hd-wm-t">Business, in your hands.</span>' : ''}</a>`;
const langSwitch = () => `<div class="hd-segs" role="group" aria-label="${esc(t('language'))}">${['cs', 'en'].map(code => `<button type="button" data-lang="${code}" aria-pressed="${state.lang === code}" lang="${code}">${code.toUpperCase()}</button>`).join('')}</div>`;
function badges(b) {
  return { audit: openQuestions(b).length, rules: proposals(b).length + pendingApprovals(b).length, agents: pendingRequests().length, website: b && activeRules(b) && !currentPublication(b) ? 1 : 0 };
}
function render() {
  if (document.documentElement) document.documentElement.lang = state.lang;
  const skip = document.querySelector('.hc-skip'); if (skip) skip.textContent = t('skip');
  if (!state.loaded) return;
  if (!state.owner) { renderAuth(); return; }
  const b = business(), count = badges(b);
  const feedback = `<div class="hc-feedback" id="feedback" role="status" aria-live="polite">${state.feedback ? note(state.feedback.tone, esc(state.feedback.text)) : ''}</div>`;
  const businesses = list(state.dashboard.businesses);
  const name = b?.name || 'Handle';
  const initials = (name.match(/[A-Za-zÀ-ž0-9]/g) || ['H']).slice(0, 2).join('').toUpperCase();
  app.innerHTML = `<div class="hc-shell">
    <aside class="hd-rail" aria-label="Handle">${wordmark()}<p class="hd-rail-l">${esc(t('console'))}</p>
      <nav aria-label="${esc(t('manage'))}">${TABS.map(id => `<button type="button" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${esc(t(`tabs.${id}`))}${count[id] ? `<span class="hd-rail-badge">${count[id]}</span>` : ''}</button>`).join('')}</nav>
      <div class="hd-rail-f"><p>${esc(t('footer'))}</p><div class="hc-rail-links">${b ? `<a href="${esc(safeUrl(b.legacy_url) || '/')}" target="_blank" rel="noopener">${esc(t('openWeb'))} ↗</a>` : ''}<a href="/handle/onboarding" target="_blank" rel="noopener">${esc(t('guide'))} ↗</a></div></div>
    </aside>
    <div class="hc-work">
      <header class="hc-top">
        <div class="hc-top-l"><span class="hc-biz"><span class="hc-biz-mark" aria-hidden="true">${esc(initials)}</span>${businesses.length > 1 ? `<select id="business-select" aria-label="${esc(t('business'))}">${businesses.map(item => `<option value="${esc(item.id)}" ${item.id === state.businessId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : `<span>${esc(name)}</span>`}</span>${chip('', 'info', t('sandbox'))}</div>
        <div class="hc-top-r"><span class="hc-email">${esc(state.owner.email)}</span>${langSwitch()}${button(t('refresh'), { variant: 'secondary', size: 'sm', attrs: 'data-action="refresh"' })}${button(t('logout'), { variant: 'ghost', size: 'sm', attrs: 'data-action="logout"' })}</div>
      </header>
      ${feedback}
      <main id="main" class="hc-main" tabindex="-1">
        <div class="hc-head"><div><h1>${esc(t(`tabs.${state.tab}`))}</h1><p>${esc(t(`leads.${state.tab}`))}</p></div></div>
        ${renderTab(b)}
        <footer class="hc-foot">${esc(t('footNote'))}</footer>
      </main>
    </div>
  </div>`;
}
function renderTab(b) {
  if (state.tab === 'get-started') return renderGetStarted();
  if (state.tab === 'overview') return renderOverview(b);
  if (state.tab === 'agents') return renderAgents(b);
  if (state.tab === 'website') return renderWebsite(b);
  if (!b) return emptyBusiness();
  return { audit: renderAudit, rules: renderRules, handover: renderHandover }[state.tab](b);
}
const emptyBusiness = () => panel(esc(t('noBusiness')), `<p>${esc(t('noBusinessText'))}</p>`);

// ---------- get started ----------
function renderGetStarted() {
  const steps = values => `<ol class="hc-start-steps">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ol>`;
  const items = values => `<ul class="hc-list">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>`;
  const owner = panel(esc(t('start.businessTitle')), `<p>${esc(t('start.businessText'))}</p>${steps(t('start.businessSteps'))}<div class="hd-actions">${button(t('copyPrompt'), { attrs: 'data-action="copy-agent-card-prompt"' })}${button(t('tabs.website'), { variant: 'secondary', attrs: 'data-tab="website"' })}</div>`);
  const customer = panel(esc(t('start.customerTitle')), `<p>${esc(t('start.customerText'))}</p>${steps(t('start.customerSteps'))}<div class="hd-actions">${button(t('start.copyCustomer'), { attrs: 'data-action="copy-customer-prompt"' })}</div><blockquote class="hc-quote">${esc(t('start.example'))}</blockquote>`);
  return `${note('info', esc(t('start.limit')))}<div class="hc-grid">${owner}${customer}</div><div class="hc-grid">${panel(esc(t('start.accessTitle')), items(t('start.access')))}${panel(esc(t('start.readyTitle')), `<p>${esc(t('start.readyText'))}</p>${items(t('start.ready'))}`)}</div>${panel(esc(t('start.modesTitle')), `<p>${esc(t('start.modesText'))}</p>${link('/handle/onboarding', t('guide'))}`)}`;
}

// ---------- login ----------
function renderAuth() {
  const signup = state.authMode === 'signup';
  const feedback = `<div id="feedback" role="status" aria-live="polite">${state.feedback ? note(state.feedback.tone, esc(state.feedback.text)) : ''}</div>`;
  app.innerHTML = `<div class="hc-login">
    <div class="hc-login-brand" data-theme="dark">${wordmark(true)}<div style="display:flex;flex-direction:column;gap:20px"><h1>${esc(t('loginTitle1'))}<br>${esc(t('loginTitle2'))} <em>${esc(t('loginTitle3'))}</em></h1><p>${esc(t('loginLead'))}</p></div><span class="hc-small hc-muted">${esc(t('footer'))}</span></div>
    <main id="main" class="hc-login-form" tabindex="-1">
      <div style="align-self:stretch;display:flex;justify-content:flex-end">${langSwitch()}</div>
      <div class="hc-login-card">
        ${feedback}
        ${requestedId ? note('info', esc(t('requestOpened'))) : ''}
        <div class="hd-segs" role="group" aria-label="${esc(t('modeLogin'))}"><button type="button" data-auth="login" aria-pressed="${!signup}">${esc(t('modeLogin'))}</button><button type="button" data-auth="signup" aria-pressed="${signup}">${esc(t('modeSignup'))}</button></div>
        <form data-form="${signup ? 'signup' : 'login'}">
          ${field(t('email'), '<input class="hd-input" name="email" type="email" autocomplete="username" required maxlength="200">')}
          ${field(signup ? t('newPassword') : t('password'), `<input class="hd-input" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? 'minlength="12"' : ''} maxlength="200" required>`)}
          ${signup ? field(t('setupCode'), '<input class="hd-input is-mono" name="setup_secret" type="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="200" required>', t('setupHint')) : ''}
          <button type="submit" class="hd-btn hd-btn-primary hd-btn-block">${esc(signup ? t('createAccount') : t('signIn'))}${ARROW}</button>
        </form>
        <span class="hc-small hc-muted">${esc(t('noPassword'))}</span><a class="hc-small" href="/handle/get-started">${esc(t('getStarted'))} →</a>
      </div>
    </main>
  </div>`;
}

// ---------- shared: connection request ----------
// Ownership readiness must be explicit; absent or stale metadata cannot enable consent.
const consentReady = request => request?.state === 'pending' && request.ownership_verification?.ready_for_consent === true && new Date(request.expires_at).getTime() > Date.now();
function requestCards() {
  return pendingRequests().map(request => {
    const id = request.id || request.request_id, proof = request.ownership_verification?.state, ready = consentReady(request);
    const status = new Date(request.expires_at).getTime() <= Date.now() || !request.ownership_verification || (!ready && proof !== 'required') ? note('warn', esc(t('verify.stale'))) : proof === 'required' ? `${note('warn', esc(t('verify.required')))}<div class="hd-actions">${button(t('verify.button'), { attrs: `data-action="verify-website" data-request="${esc(id)}"` })}${button(t('verify.check'), { variant: 'secondary', attrs: 'data-action="refresh"' })}</div>` : note('ok', esc(proof === 'verified' ? t('verify.verified') : t('verify.notRequired')));
    return panel(esc(t('requestTitle', request.runtime || t('colAgent'))), `<div class="hc-split">
      <div>${meta([[t('requestFrom'), esc(request.runtime || '—')], [t('website'), link(request.legacy_url)], [t('validUntil'), esc(date(request.expires_at))]])}${status}</div>
      <form class="hc-form" data-form="consent" data-request="${esc(id)}">
        ${field(t('codeLabel'), `<input class="hd-input is-mono" name="user_code" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" required placeholder="${esc(t('codePh'))}">`)}
        <fieldset class="hc-opts" style="display:block"><legend>${esc(t('wantsTo'))}</legend><div class="hc-scopes">${AUDIT_SCOPES.map(scope => `<label class="hc-scope"><input type="checkbox" name="scopes" value="${esc(scope)}" checked><span class="l">${esc(scopeLabel(scope))}</span><span class="hc-code">${esc(scope)}</span></label>`).join('')}</div></fieldset>
        ${check('reviewed', t('confirmAgent'), t('confirmAgentHint'))}
        <div class="hd-actions">${button(t('approveConnection'), { type: 'submit', attrs: `name="decision" value="approved" ${ready ? '' : 'disabled data-ownership-blocked="true" aria-disabled="true"'}` })}${button(t('reject'), { variant: 'secondary', type: 'submit', attrs: 'name="decision" value="rejected" formnovalidate' })}</div>
      </form></div>`, { cls: 'is-ask', sub: chip('pending', 'escalation', `${t('validUntil')} ${new Date(request.expires_at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' })}`) });
  }).join('');
}
// The owner proves website control through the website's own admin login; Handle never sees that password.
async function verifyWebsite(requestId) {
  const v = key => t(`verify.${key}`), requestPath = `/owner/onboarding/${encodeURIComponent(requestId)}/ownership-challenge`;
  const challenge = await api(requestPath);
  if (!challenge.challenge) { state.feedback = { tone: 'ok', text: v('doneBefore') }; await load(); return; }
  if (new URL(challenge.legacy_url).origin !== location.origin || challenge.publication_api !== '/api/admin/handle-ownership-proof' || challenge.public_path !== '/.well-known/handle-ownership.json') throw new Error(v('wrongSite'));
  const legacy = async (path, body, csrf) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(path === '/api/login' ? v('badLogin') : v('needOwner'));
    return data;
  };
  const session = await legacy('/api/session'), needsLogin = session.actor?.role !== 'owner' || !session.csrf_token;
  dialog.innerHTML = `<form class="hd-dlg" data-website-proof><div><h2 id="dialog-title">${esc(v('title'))}</h2></div><div class="hd-dlg-b"><p>${esc(v('text'))}</p><p class="hc-small hc-muted">${esc(v('note'))}</p>${needsLogin ? `${field(v('user'), '<input class="hd-input" name="legacy_username" autocomplete="username" value="owner" required maxlength="200">')}${field(v('pass'), '<input class="hd-input" name="legacy_password" type="password" autocomplete="current-password" required maxlength="200">')}` : `<p>${esc(v('already'))}</p>`}${check('publish_allowed', v('allow'))}<div data-website-proof-error role="alert" hidden></div></div><div class="hd-dlg-f">${button(t('cancel'), { variant: 'ghost', attrs: 'data-action="close-dialog"' })}${button(v('submit'), { type: 'submit' })}</div></form>`;
  const form = dialog.querySelector('form'), error = form.querySelector('[data-website-proof-error]');
  dialog.addEventListener('close', () => { form.querySelectorAll('input[type=password]').forEach(input => input.value = ''); dialog.innerHTML = ''; }, { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation(); if (state.busy) return;
    const data = new FormData(form), submit = form.querySelector('[type=submit]');
    if (!data.get('publish_allowed')) return;
    state.busy = true; submit.disabled = true; error.hidden = true;
    try {
      if (needsLogin) {
        const account = { username: String(data.get('legacy_username') || ''), password: String(data.get('legacy_password') || '') };
        form.querySelector('[name=legacy_password]').value = '';
        try { await legacy('/api/login', account); } finally { account.password = ''; }
      }
      const current = await api(requestPath);
      if (current.challenge) {
        const native = await legacy('/api/session');
        if (native.actor?.role !== 'owner' || !native.csrf_token) throw new Error(v('needOwner'));
        await legacy('/api/admin/handle-ownership-proof', { challenge: current.challenge }, native.csrf_token);
        const response = await fetch('/.well-known/handle-ownership.json', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
        const published = await response.json().catch(() => ({}));
        if (!response.ok || published.challenge !== current.challenge) throw new Error(v('mismatch'));
      }
      if (!consentReady(await api(`/owner/onboarding/${encodeURIComponent(requestId)}`))) throw new Error(v('notReady'));
      dialog.close(); state.feedback = { tone: 'ok', text: v('done') }; await load();
    } catch (failure) { error.innerHTML = note('bad', esc(failure.message)); error.hidden = false; }
    finally { state.busy = false; submit.disabled = false; }
  });
  dialog.showModal();
}

// ---------- overview ----------
function renderOverview(b) {
  const next = nextStep(b), requests = requestCards();
  if (!b) return requests + emptyBusiness();
  const active = activeRules(b), all = cases(b);
  const quoted = all.filter(item => item.quote_id), booked = all.filter(item => item.order_id), paid = all.filter(isPaid), accepted = all.filter(item => item.status === 'accepted' || item.order_id);
  const value = booked.reduce((sum, item) => sum + (item.quote?.price?.total_minor || 0), 0);
  const steps = [true, Boolean(b.relay), Boolean(reports(b).length), Boolean(active), Boolean(currentPublication(b))];
  const current = steps.indexOf(false);
  const banner = next ? `<section class="hc-next"><div class="hc-next-t"><span class="hc-next-k">${esc(next.owner ? t('nextStep') : t('agentWorking'))}</span><strong>${esc(next.title)}</strong><span class="d">${esc(next.text)}</span></div>${next.tab !== 'overview' ? `<button type="button" class="hd-btn hd-btn-primary" data-tab="${next.tab}">${esc(next.owner ? t('review') : t('open'))}${ARROW}</button>` : ''}</section>` : '';
  const flow = `<ol class="hd-flow" aria-label="${esc(t('nextStep'))}">${t('steps').map((label, index) => `<li class="${steps[index] ? 'is-done' : index === current ? 'is-current' : ''}" ${index === current ? 'aria-current="step"' : ''}><b>0${index + 1}${steps[index] ? ' ✓' : ''}</b><strong>${esc(label)}</strong><span>${esc(t('stepsD')[index])}</span></li>`).join('')}</ol>`;
  const kpis = `<div class="hc-stats">${stat(t('kConversations'), all.length, t('kConversationsD'))}${stat(t('kQuotes'), quoted.length, t('kQuotesD'))}${stat(t('kBookings'), booked.length, t('kBookingsD', paid.length))}${stat(t('kValue'), money(value), t('kValueD'))}${stat(t('kExceptions'), pendingApprovals(b).length, t('kExceptionsD'))}${stat(t('kRules'), active ? `v${active.version}` : '—', t('kRulesD', active?.version))}</div>`;
  return `${requests}${banner}${flow}${kpis}<div class="hc-grid hc-grid-wide">${chartPanel(all)}${funnelPanel(all.length, quoted.length, accepted.length, paid.length)}</div><div class="hc-grid">${discountPanel(b, all)}${waitingPanel(b)}</div>`;
}
function chartPanel(all) {
  const days = [...Array(14)].map((_, index) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13 + index); return d; });
  const key = value => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const q = days.map(day => all.filter(item => item.quote && key(item.quote.created_at) === day.getTime()).length);
  const o = days.map(day => all.filter(item => item.order && key(item.order.created_at) === day.getTime()).length);
  const max = Math.max(3, ...q, ...o);
  const body = all.length ? `<div class="hc-chart"><div class="hc-chart-y" aria-hidden="true"><span>${max}</span><span>${Math.round(max / 2)}</span><span>0</span></div><div class="hc-chart-area"><div class="hc-chart-grid" aria-hidden="true"><div></div><div></div><div></div></div><div class="hc-chart-bars">${days.map((day, index) => `<div class="hc-chart-col" title="${esc(day.toLocaleDateString(locale()))} · ${esc(t('chartQuotes'))} ${q[index]} · ${esc(t('chartBookings'))} ${o[index]}"><div class="bars"><div style="height:${q[index] / max * 100}%;background:var(--gray-500)"></div><div style="height:${o[index] / max * 100}%;background:var(--ink)"></div></div><span>${day.getDate()}</span></div>`).join('')}</div></div></div>` : `<p class="hc-empty">${esc(t('chartEmpty'))}</p>`;
  return panel(esc(t('chartTitle')), body, { cls: 'is-wide', sub: `<div class="hc-legend"><span><i style="background:var(--gray-500)"></i>${esc(t('chartQuotes'))} ${q.reduce((a, n) => a + n, 0)}</span><span><i style="background:var(--ink)"></i>${esc(t('chartBookings'))} ${o.reduce((a, n) => a + n, 0)}</span></div>` });
}
function funnelPanel(conversations, quotes, accepted, paid) {
  const rows = [[t('fConv'), conversations], [t('fQuote'), quotes], [t('fAccepted'), accepted], [t('fPaid'), paid]];
  return panel(esc(t('funnel')), `<div style="display:flex;flex-direction:column;gap:12px">${rows.map(([label, value]) => `<div class="hc-hbar"><div class="hc-hbar-l"><span>${esc(label)}</span><span><b>${value}</b>${conversations ? ` · ${Math.round(value / conversations * 100)} %` : ''}</span></div><div class="hc-hbar-t"><div style="width:${conversations ? value / conversations * 100 : 0}%"></div></div></div>`).join('')}</div>`);
}
function discountBands(rules) {
  const p = rules?.params || {};
  return [[t('dNone'), bps => bps === 0, 'var(--ink)'], [`${t('dAuto')} ≤ ${pct(p.auto_discount_bps)}`, bps => bps > 0 && bps <= (p.auto_discount_bps ?? 0), 'var(--ink)'], [`${t('dOwner')} ≤ ${pct(p.owner_approval_limit_bps)}`, bps => bps > (p.auto_discount_bps ?? 0) && bps <= (p.owner_approval_limit_bps ?? 0), 'var(--gray-500)'], [t('dBlocked'), bps => bps > (p.owner_approval_limit_bps ?? 0), 'var(--bad)']];
}
function discountPanel(b, all) {
  const active = activeRules(b), quoted = all.filter(item => item.quote?.price);
  const bands = discountBands(active).map(([label, test, fill]) => ({ label, fill, value: quoted.filter(item => test(item.quote.price.discount_bps || 0)).length }));
  const max = Math.max(1, ...bands.map(band => band.value));
  const body = `${active ? discountBar(active) : ''}<div style="display:flex;flex-direction:column;gap:12px">${bands.map(band => `<div class="hc-hbar"><div class="hc-hbar-l"><span>${esc(band.label)}</span><b>${band.value}</b></div><div class="hc-hbar-t"><div style="width:${band.value / max * 100}%;background:${band.fill}"></div></div></div>`).join('')}</div>`;
  return panel(esc(t('discounts')), body, { sub: active ? ref(`v${active.version}`) : '' });
}
function discountBar(rule, highlight) {
  const p = rule.params || {}, limit = Math.max(p.hard_discount_limit_bps || 0, p.owner_approval_limit_bps || 0, highlight || 0, 1);
  const autoW = (p.auto_discount_bps || 0) / limit * 100, ownerW = ((p.owner_approval_limit_bps || 0) - (p.auto_discount_bps || 0)) / limit * 100;
  return `<div class="hc-bar"><div class="hc-bar-track" aria-hidden="true"><div style="flex:${autoW};background:var(--ink)"></div><div style="flex:${ownerW};background:var(--gray-500)"></div>${100 - autoW - ownerW > 0 ? `<div style="flex:${100 - autoW - ownerW};background:var(--bad-soft)"></div>` : ''}</div><div class="hc-bar-legend"><span>0 %</span><span>${esc(t('barAuto'))} ${pct(p.auto_discount_bps)}</span>${highlight !== undefined ? `<span style="color:var(--ink)">${pct(highlight)}</span>` : ''}<span>${esc(t('barOwner'))} ${pct(p.owner_approval_limit_bps)}</span></div></div>`;
}
function waitingPanel(b) {
  const items = [
    ...pendingRequests().map(request => [t('requestTitle', request.runtime || t('colAgent')), 'agents', chip('pending', 'escalation', t('waitsForYou'))]),
    ...proposals(b).map(rule => [t('proposalTitle', rule.version), 'rules', chip('proposed', 'wait')]),
    ...openQuestions(b).map(question => [question.question, 'audit', question.critical ? chip('', 'warn', t('critical')) : chip('', 'neutral', t('question'))]),
    ...pendingApprovals(b).map(approval => [`${t('exceptionsTitle')} · ${pct(approval.quote?.price?.discount_bps)}`, 'rules', chip('pending', 'escalation', t('waitsForYou'))]),
  ];
  return panel(esc(t('waitingForYou')), items.length ? `<ul class="hc-list">${items.map(([label, tab, status]) => `<li><div class="grow"><button type="button" class="hc-link" data-tab="${tab}">${esc(label)}</button></div>${status}</li>`).join('')}</ul>` : `<p class="hc-empty">${esc(t('nothingWaiting'))}</p>`, { sub: `<span class="hc-sub">${items.length}</span>` });
}

// ---------- audit ----------
// datetime-local uses the browser's timezone; keep the stored instant and precision on edit.
function answerExpiryInput(value) {
  if (!value) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
function answerForm(report, question, answer) {
  const expiry = answerExpiryInput(answer?.valid_until);
  return `<form class="hc-form" data-form="answer" data-version="${esc(report.version)}" data-question="${esc(question.id)}" data-expiry-original="${esc(answer?.valid_until)}" data-expiry-local="${esc(expiry)}">
      ${field(t('yourAnswer'), `<textarea class="hd-input" name="answer" required maxlength="8000" placeholder="${esc(t('answerPh'))}">${esc(answer?.answer)}</textarea>`)}
      <fieldset class="hc-opts"><legend>${esc(t('answerType'))}</legend><label class="hc-opt"><input type="radio" name="kind" value="policy_decision" ${answer?.kind !== 'external_fact' ? 'checked' : ''}><span>${esc(t('kindPolicy'))}<small>${esc(t('kindPolicySub'))}</small></span></label><label class="hc-opt"><input type="radio" name="kind" value="external_fact" ${answer?.kind === 'external_fact' ? 'checked' : ''}><span>${esc(t('kindFact'))}<small>${esc(t('kindFactSub'))}</small></span></label></fieldset>
      <div class="hc-fields">${field(t('scope'), `<input class="hd-input" name="scope" required maxlength="2000" value="${esc(answer?.scope ?? t('scopeDefault'))}">`)}${field(t('until'), `<input class="hd-input" name="valid_until" type="datetime-local" step="any" value="${esc(expiry)}">`)}</div>
      <div class="hd-actions">${button(t('saveAnswer'), { type: 'submit' })}</div></form>`;
}
function renderAudit(b) {
  const all = reports(b);
  if (!all.length) return panel(esc(t('auditEmpty')), `<p>${esc(t('auditEmptyText'))}</p>`);
  const report = all.find(item => item.version === state.auditVersion) || all[0];
  const questions = list(report.questions), answered = questions.filter(question => answerFor(report, question));
  const attention = list(report.findings).filter(finding => finding.severity !== 'info');
  const versions = all.length > 1 ? `<div class="hd-segs" role="group" aria-label="${esc(t('version', ''))}">${all.map(item => `<button type="button" data-audit-version="${item.version}" aria-pressed="${item.version === report.version}">${esc(t('version', item.version))}</button>`).join('')}</div>` : '';
  const stats = `<div class="hc-stats">${stat(t('sSystems'), list(report.systems).length, '', 100)}${stat(t('sEvidence'), list(report.evidence).length, '', 100)}${stat(t('sAnswered'), `${answered.length}/${questions.length}`, '', questions.length ? answered.length / questions.length * 100 : 100)}${stat(t('sFindings'), attention.length, '', attention.length ? 100 : 0)}</div>`;
  const open = questions.filter(question => !answerFor(report, question)).map(question => panel(esc(question.question), answerForm(report, question), { cls: 'is-ask', sub: `<div class="hc-row">${question.critical ? chip('', 'warn', t('critical')) : ''}${chip('pending', 'escalation', t('question'))}</div>` })).join('');
  const systems = table([[t('colSystem')], [t('colAuthority')], [t('colAccess')], [t('colRoles')]], list(report.systems).map(system => `<tr><td><strong style="font-weight:500">${esc(system.name || system.id)}</strong><span class="hc-code">${esc(system.id)}</span></td><td>${esc(list(system.fact_authority).join(', ') || system.purpose || '—')}</td><td>${esc(list(system.access_methods).join(', ') || '—')}</td><td>${esc(list(system.observed_roles).join(', ') || '—')}</td></tr>`), t('none'));
  const findings = panel(esc(t('findingsTitle')), list(report.findings).length ? `<ul class="hc-list">${report.findings.map(finding => `<li style="align-items:flex-start">${chip('', finding.severity === 'critical' ? 'bad' : finding.severity === 'warning' ? 'warn' : 'info', t(`sev.${finding.severity}`))}<div class="grow"><span>${esc(finding.description)}</span>${finding.recommendation ? `<span class="hc-small hc-muted">${esc(finding.recommendation)}</span>` : ''}</div></li>`).join('')}</ul>` : `<p class="hc-empty">${esc(t('noFindings'))}</p>`);
  const answeredPanel = answered.length ? panel(esc(t('answeredTitle')), `<ul class="hc-list">${answered.map(question => { const answer = answerFor(report, question); return `<li style="align-items:flex-start"><div class="grow"><strong>${esc(question.question)}</strong><span>${esc(answer.answer)}</span>${tech(meta([[t('scope'), esc(answer.scope)], [t('until'), esc(answer.valid_until ? date(answer.valid_until) : '—')], ['ID', esc(question.id), true]]))}<details class="hc-tech"><summary>${esc(t('updateAnswer'))}</summary><div>${answerForm(report, question, answer)}</div></details></div>${chip('', answer.kind === 'policy_decision' ? 'owner' : 'info', answer.kind === 'policy_decision' ? t('kindPolicyShort') : t('kindFactShort'))}</li>`; }).join('')}</ul>`) : '';
  const evidence = panel(esc(t('evidenceTitle')), tech(...list(report.evidence).map(item => `<div>${meta([[t('colSystem'), esc(item.capture?.system_id)], ['URL', link(item.url || item.capture?.url)], ['Locator', esc(item.capture?.locator)], [t('colChecked'), esc(date(item.capture?.captured_at))], ['SHA-256', esc(item.hash), true]])}${item.content ? `<blockquote class="hc-quote">${esc(String(item.content).slice(0, 600))}</blockquote>` : ''}</div>`), meta([['Report', esc(`v${report.version}`), true], ['Status', esc(report.status || '—')], ['Hash', esc(report.payload_hash || '—'), true]])), { sub: `<span class="hc-sub">${list(report.evidence).length}</span>` });
  return `${versions ? `<div class="hc-row">${versions}</div>` : ''}${report.summary ? `<p class="hc-muted">${esc(report.summary)}</p>` : ''}${stats}${open}<section class="hc-panel" style="padding:0;background:none"><div class="hc-panel-h" style="padding:0 4px"><h2>${esc(t('systemsTitle'))}</h2></div>${systems}</section><div class="hc-grid">${findings}${answeredPanel}</div>${evidence}`;
}

// ---------- rules ----------
function rulesList(lines) { return `<ul class="hc-rules">${list(lines).map(line => `<li>${esc(line.text)}</li>`).join('')}</ul>`; }
function blockedProposal(b, rule) {
  const report = reports(b).find(item => item.version === rule.governance?.report_version);
  return list(rule.governance?.blocked_parameters).length > 0 || list(report?.questions).some(question => question.critical && !answerFor(report, question));
}
function proposalBlockReasons(b, rule) {
  const report = reports(b).find(item => item.version === rule.governance?.report_version);
  const questions = list(report?.questions).filter(question => question.critical && !answerFor(report, question));
  const blocked = list(rule.governance?.blocked_parameters);
  const findings = [
    ...list(rule.findings).filter(finding => finding.severity === 'critical').map(finding => ({ ...finding, source: t('findingRule') })),
    ...list(report?.findings).filter(finding => finding.severity === 'critical').map(finding => ({ ...finding, source: t('findingReport', report.version) })),
  ];
  const questionHtml = questions.length ? `<p>${esc(t('blockedQuestions'))}</p><ul>${questions.map(question => `<li>${esc(question.question)}</li>`).join('')}</ul>` : '';
  const blockedHtml = blocked.length ? `<p>${esc(t('blockedParameters'))}</p>${findings.length ? `<p><strong>${esc(t('blockedFindings'))}</strong></p><ul>${findings.map(finding => `<li><span class="hc-small hc-muted">${esc(finding.source)}</span><div>${esc(finding.description)}</div>${finding.recommendation ? `<div>${esc(finding.recommendation)}</div>` : ''}</li>`).join('')}</ul>` : `<p>${esc(t('blockedFallback'))}</p>`}${tech(meta([[t('blockedParameterList'), blocked.map(esc).join(', ')]]))}` : '';
  return note('warn', questionHtml + blockedHtml);
}
function renderRules(b) {
  const all = rulebooks(b), active = activeRules(b), waiting = proposals(b), approvals = list(b.approvals);
  const stats = `<div class="hc-stats">${stat(t('sActive'), active ? `v${active.version}` : '—', active?.activated_at ? t('activeSince', date(active.activated_at)) : '')}${stat(t('sProposal'), waiting.length)}${stat(t('sApprovals'), pendingApprovals(b).length)}${active ? stat(t('sDeposit'), money(active.params?.deposit_minor)) : ''}</div>`;
  if (!all.length) return stats + panel(esc(t('rulesEmpty')), `<p>${esc(t('rulesEmptyText'))}</p>`) + exceptionsPanel(b, approvals);
  const proposalPanels = waiting.map(rule => {
    const words = describeRules(rule.params), changes = describeChanges(active?.params, rule.params), blocked = blockedProposal(b, rule);
    const changeHtml = active && changes.length ? `<div><h3 class="hc-small hc-muted" style="margin-bottom:4px">${esc(t('whatChanges'))}</h3>${changes.map(change => `<div class="hc-change">${change.before ? `<span class="was">${esc(change.before)}</span>` : ''}<span class="now">${esc(change.after)}</span></div>`).join('')}</div>` : `<div><h3 class="hc-small hc-muted" style="margin-bottom:4px">${esc(t('firstRules'))}</h3>${rulesList(words)}</div>`;
    return panel(esc(t('proposalTitle', rule.version)), `${changeHtml}${active && changes.length ? `<details class="hc-tech"><summary>${esc(t('allRules'))}</summary><div>${rulesList(words)}</div></details>` : ''}
      <form class="hc-form" data-form="activate" data-version="${esc(rule.version)}" data-hash="${esc(rule.payload_hash)}">${blocked ? proposalBlockReasons(b, rule) : ''}${check('reviewed', t('confirmRules'))}<div class="hd-actions">${button(t('activate', rule.version), { type: 'submit', attrs: blocked || !rule.payload_hash ? 'disabled' : '' })}</div></form>
      ${tech(meta([['Payload hash', esc(rule.payload_hash), true], ['Report', esc(rule.governance?.report_version ? `audit v${rule.governance.report_version}` : '—'), true]]), paramTable(active, rule), citationsHtml(rule))}`, { cls: 'is-ask', sub: chip('proposed', 'escalation', t('waitsForYou')) });
  }).join('');
  const activePanel = active ? panel(esc(t('activeTitle', active.version)), `${discountBar(active)}${rulesList(describeRules(active.params))}${tech(meta([['Payload hash', esc(active.payload_hash), true], [t('activeSince', ''), esc(date(active.activated_at))]]), paramTable(null, active), citationsHtml(active))}`, { sub: chip('active') }) : '';
  const older = all.filter(rule => rule.status === 'superseded');
  return `${stats}${proposalPanels}${activePanel}${exceptionsPanel(b, approvals)}${older.length ? panel(esc(t('olderVersions')), tech(...older.map(rule => `<div><strong>v${esc(rule.version)}</strong> ${chip(rule.status)}${rulesList(describeRules(rule.params))}</div>`))) : ''}`;
}
function paramTable(active, rule) {
  const keys = [...new Set([...Object.keys(active?.params || {}), ...Object.keys(rule.params || {})])];
  return `<div class="hd-tscroll" style="padding:0"><table class="hd-tbl"><thead><tr><th scope="col">${esc(t('param'))}</th>${active ? `<th scope="col">v${esc(active.version)}</th>` : ''}<th scope="col">v${esc(rule.version)}</th></tr></thead><tbody>${keys.map(key => `<tr><td class="is-mono">${esc(key)}</td>${active ? `<td class="is-mono">${esc(JSON.stringify(active.params?.[key]))}</td>` : ''}<td class="is-mono"${active && JSON.stringify(active.params?.[key]) !== JSON.stringify(rule.params?.[key]) ? ' style="background:var(--ok-soft)"' : ''}>${esc(JSON.stringify(rule.params?.[key]))}</td></tr>`).join('')}</tbody></table></div>`;
}
function citationsHtml(rule) { const entries = Object.entries(rule.evidence || {}); return entries.length ? `<div>${entries.map(([key, cites]) => `<p class="hc-small"><span class="hc-code">${esc(key)}</span> ← ${list(cites).map(cite => esc(cite.source_id)).join(', ')}</p>`).join('')}</div>` : ''; }
function exceptionsPanel(b, approvals) {
  const rows = approvals.map(approval => { const quote = approval.quote; return `<tr><td><span>${esc(serviceText(quote?.price?.service_spec))}</span><span class="hc-small hc-muted" style="display:block">${esc(date(quote?.created_at))}</span></td><td class="is-r">${esc(pct(quote?.price?.discount_bps))}</td><td class="is-r">${esc(money(quote?.price?.total_minor))}</td><td>${chip(approval.status)}</td><td class="is-act">${approval.status === 'pending' ? button(t('review'), { size: 'sm', attrs: `data-approval="${esc(approval.id)}"` }) : ''}</td></tr>`; });
  return `<section class="hc-panel" style="padding:0;background:none"><div class="hc-panel-h" style="padding:0 4px"><h2>${esc(t('exceptionsTitle'))}</h2></div>${table([[t('colOffer')], [t('colDiscount'), 'is-r'], [t('colTotal'), 'is-r'], [t('colState')], ['', 'is-r']], rows, t('noExceptions'))}</section>`;
}
function openApproval(id) {
  const b = business(), approval = list(b?.approvals).find(item => item.id === id); if (!approval) return;
  const quote = approval.quote, price = quote?.price, active = activeRules(b), expired = !quote || Date.parse(quote.expires_at) <= Date.now();
  const discount = price ? price.base_total_minor - price.total_minor : 0;
  dialog.innerHTML = `<form class="hd-dlg" data-form="approval" data-approval="${esc(approval.id)}" method="dialog">
    <div><span class="hd-kicker">${esc(t('exceptionKicker', approval.rulebook_version))}</span><h2 id="dialog-title">${esc(t('exceptionTitle', pct(price?.discount_bps)))}</h2></div>
    <div class="hd-dlg-b">${active ? discountBar(active, price?.discount_bps) : ''}
      <div class="hc-lines">${list(price?.line_items).map(line => `<div><span>${esc(lineLabel(line.label))}</span><span>${esc(money(line.amount_minor))}</span></div>`).join('')}${discount ? `<div><span>${esc(t('discountLine', pct(price.discount_bps)))}</span><span>−${esc(money(discount))}</span></div>` : ''}<div class="total"><span>${esc(t('total'))}</span><span>${esc(money(price?.total_minor))}</span></div></div>
      ${meta([[t('case'), esc(serviceText(price?.service_spec))], [t('expires'), esc(date(quote?.expires_at))]])}${tech(meta([['Case', esc(approval.case_id), true], ['Quote', esc(`${approval.quote_id} · v${approval.quote_version}`), true], [t('slot'), esc(quote?.slot_id || '—'), true]]))}
      ${expired ? note('warn', esc(t('expired'))) : check('reviewed', t('confirmException'), `sha256:${String(approval.quote_hash || '').slice(0, 4)}…${String(approval.quote_hash || '').slice(-4)}`)}
    </div>
    <div class="hd-dlg-f">${button(t('cancel'), { variant: 'ghost', attrs: 'data-action="close-dialog"' })}${button(t('reject'), { variant: 'secondary', type: 'submit', attrs: `name="decision" value="rejected" ${expired ? 'disabled' : ''}` })}${button(t('approveException'), { type: 'submit', attrs: `name="decision" value="approved" ${expired ? 'disabled' : ''}` })}</div>
  </form>`;
  dialog.showModal();
}

// ---------- agents ----------
function renderAgents(b) {
  const requests = requestCards();
  if (!b) return requests + emptyBusiness();
  const active = activeRules(b), connections = list(b.connections);
  const rows = connections.map(c => { const perms = connectionScopes(c); return `<tr ${c.id === b.active_connection_id ? 'aria-selected="true"' : ''}><td><strong style="font-weight:500">${esc(runtimeName(c))}</strong></td><td>${chip(c.state)}</td><td>${esc(c.id === b.active_connection_id ? t('yes') : t('no'))}</td><td>${active ? chip('', proofCurrent(b, c) ? 'ok' : 'warn', proofCurrent(b, c) ? t('yes') : t('no')) : '—'}</td><td class="is-r">${perms.length}</td></tr>`; });
  const agentsTable = table([[t('colAgent')], [t('colState')], [t('colWorking')], [t('colReady')], [t('colPerms'), 'is-r']], rows, t('agentsEmpty'));
  const panels = connections.map(c => {
    const perms = connectionScopes(c), revoked = ['revoked', 'suspended'].includes(c.state), ready = proofCurrent(b, c), proof = readiness(c);
    if (revoked) return panel(esc(runtimeName(c)), `<p class="hc-muted">${esc(t('revokedNote'))}</p>${tech(meta([['Connection', esc(c.id), true]]))}`, { sub: chip(c.state) });
    const canGrant = Boolean(active && ready);
    const scopeRow = (scope, editable) => `<label class="hc-scope ${perms.includes(scope) ? '' : 'is-off'}"><input type="checkbox" ${editable ? 'name="scopes"' : 'disabled'} value="${esc(scope)}" ${perms.includes(scope) ? 'checked' : ''} ${editable && !canGrant ? 'disabled' : ''}><span class="l">${esc(scopeLabel(scope))}</span><span class="hc-code">${esc(scope)}</span></label>`;
    return panel(esc(t('permsTitle', runtimeName(c))), `${active ? note(ready ? 'ok' : 'warn', esc(ready ? t('readyOk') : t('readyMissing'))) : note('info', esc(t('needsRules')))}
      <form class="hc-form" data-form="grant" data-connection="${esc(c.id)}">
        <div><h3 class="hc-small hc-muted">${esc(t('setupPerms'))}</h3><div class="hc-scopes">${AUDIT_SCOPES.filter(scope => perms.includes(scope)).map(scope => scopeRow(scope, false)).join('')}</div></div>
        <div><h3 class="hc-small hc-muted">${esc(t('workPerms'))}</h3><div class="hc-scopes">${OPERATION_SCOPES.map(scope => scopeRow(scope, true)).join('')}</div></div>
        ${canGrant ? check('reviewed', t('confirmPerms')) : ''}
        <div class="hd-actions">${button(t('savePerms'), { type: 'submit', variant: 'secondary', attrs: canGrant ? '' : 'disabled' })}</div>
      </form>
      <details class="hc-tech"><summary>${esc(t('revokeTitle'))}</summary><div><form class="hc-form" data-form="revoke" data-connection="${esc(c.id)}"><p class="hc-small">${esc(t('revokeText'))}</p>${check('reviewed', t('confirmRevoke'))}<div class="hd-actions">${button(t('revoke'), { variant: 'danger', type: 'submit' })}</div></form></div></details>
      ${tech(meta([['Connection', esc(c.id), true], ['Principal', esc(c.principal_id), true], ['Epoch', esc(b.execution_epoch)], ['Probe', esc(proof ? `${proof.method || ''} · ${date(proof.verified_at)}` : '—')], ['Rulebook hash', esc(proof?.rulebook_hash || '—'), true]]))}`, { sub: chip(c.state) });
  }).join('');
  return `${requests}${agentsTable}<div class="hc-grid">${panels}</div>`;
}

// ---------- website ----------
function renderWebsite(b) {
  const introduction = panel(esc(t('webTitle')), `<p>${esc(t('webText'))}</p><div class="hd-actions">${button(t('copyPrompt'), { attrs: 'data-action="copy-agent-card-prompt"' })}${button(t('getStarted'), { variant: 'secondary', attrs: 'data-tab="get-started"' })}</div>`);
  if (!b) return introduction;
  const active = activeRules(b), grant = publishGrant(b), current = currentPublication(b), publications = list(b.publications);
  const cardUrl = `${String(b.legacy_url || location.origin).replace(/\/$/, '')}/.well-known/agent-card.json`;
  const banner = !current && active ? (() => { const [title, text] = grant ? t('webNextAgent') : t('webNext'); return `<section class="hc-next"><div class="hc-next-t"><span class="hc-next-k">${esc(grant ? t('agentWorking') : t('nextStep'))}</span><strong>${esc(title)}</strong><span class="d">${esc(text)}</span></div>${grant ? '' : `<button type="button" class="hd-btn hd-btn-primary" data-tab="agents">${esc(t('grantPublish'))}${ARROW}</button>`}</section>`; })() : '';
  const checks = [[t('cRules'), active ? chip('active', 'ok', `v${active.version}`) : chip('', 'bad', t('missing'))], [t('cGrant'), grant ? chip('', 'ok', t('okActive')) : chip('', 'bad', t('missing'))], [t('cCheck'), current ? chip('verified', 'ok', t('published')) : chip('', 'warn', t('waiting'))], [t('cCard'), link(cardUrl, t('viewCard'))]];
  const rows = publications.map(item => `<tr><td class="is-mono">${esc(item.id)}</td><td>${chip(item.state)}</td><td class="is-mono">${esc(String(item.rulebook_hash || '—').slice(0, 12))}${item.rulebook_hash ? '…' : ''}</td><td>${esc(date(item.verified_at))}</td></tr>`);
  return `${introduction}<details class="hc-tech"><summary>${esc(t('publicationDetails'))}</summary><div>${banner}<ul class="hc-list">${checks.map(([label, value]) => `<li><div class="grow"><strong>${esc(label)}</strong></div>${value}</li>`).join('')}</ul><h2>${esc(t('revisions'))}</h2>${table([[t('colRevision')], [t('colState')], ['Rulebook'], [t('colChecked')]], rows, t('noRevisions'))}</div></details>`;
}

async function copySetupPrompt(target, kind = 'business') {
  state.busy = true; target.disabled = true;
  try {
    const response = await fetch(kind === 'customer' ? '/handle/customer-prompt' : '/handle/agent-card-prompt', { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'text/plain' } });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain')) throw new Error(t('promptLoadError'));
    const template = await response.text();
    if (!template.trim()) throw new Error(t('promptLoadError'));
    const prompt = template.replaceAll('[WEBSITE_URL]', business()?.legacy_url || (state.tab === 'get-started' ? location.origin : '[WEBSITE_URL]'));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      state.feedback = { tone: 'ok', text: t('promptCopied') }; render();
    } catch {
      state.feedback = null; render();
      dialog.innerHTML = `<div class="hd-dlg"><div><h2 id="dialog-title">${esc(t('promptManualTitle'))}</h2></div><div class="hd-dlg-b"><p>${esc(t('promptManualText'))}</p>${field(t('copyPrompt'), '<textarea class="hd-input is-mono" rows="14" readonly data-agent-card-prompt style="width:100%;resize:vertical"></textarea>')}</div><div class="hd-dlg-f">${button(t('selectPrompt'), { variant: 'secondary', attrs: 'data-action="select-agent-card-prompt"' })}${button(t('cancel'), { attrs: 'data-action="close-dialog"' })}</div></div>`;
      const input = dialog.querySelector('[data-agent-card-prompt]'); input.value = prompt;
      dialog.showModal(); input.focus(); input.select();
    }
  } catch {
    state.feedback = { tone: 'bad', text: t('promptLoadError') }; render();
  } finally { state.busy = false; if (target.isConnected) target.disabled = false; }
}

// ---------- handover ----------
function renderHandover(b) {
  const active = activeRules(b), connections = list(b.connections), live = connections.filter(c => !['revoked', 'suspended'].includes(c.state));
  const candidates = live.filter(c => c.id !== b.active_connection_id), all = cases(b), open = all.filter(item => !isPaid(item));
  const handoffs = list(b.handoffs), committed = handoffs.some(item => item.state === 'committed');
  const governing = reports(b).find(report => report.version === active?.governance?.report_version) || reports(b)[0];
  const external = list(governing?.systems).filter(system => list(system.observed_roles).some(role => !['public', 'anonymous', 'service_account'].includes(role)));
  const steps = [Boolean(b.active_connection_id), candidates.length > 0, candidates.some(c => proofCurrent(b, c)), handoffs.some(item => list(item.external_access).every(access => access.state === 'verified_revoked')), committed];
  const current = steps.indexOf(false);
  const stats = `<div class="hc-stats">${stat(t('hOpen'), open.length)}${stat(t('hValue'), money(open.reduce((sum, item) => sum + (item.quote?.price?.total_minor || 0), 0)))}${stat(t('hAgents'), live.length)}${stat(t('hSaved'), handoffs.length)}</div>`;
  const flow = `<ol class="hd-flow">${t('hFlow').map((label, index) => `<li class="${steps[index] ? 'is-done' : index === current ? 'is-current' : ''}"><b>0${index + 1}${steps[index] ? ' ✓' : ''}</b><strong>${esc(label)}</strong></li>`).join('')}</ol>`;
  const caseRows = all.map(item => `<tr><td><span>${esc(serviceText(item.service_spec))}</span><span class="hc-code">${esc(item.id)}</span></td><td>${chip(item.status)}</td><td class="is-r">${esc(money(item.quote?.price?.total_minor))}</td><td>${esc(item.quote ? date(item.quote.created_at) : '—')}</td><td>${list(item.payment).length ? list(item.payment).map(payment => chip(payment.state)).join(' ') : '—'}</td></tr>`);
  const casesPanel = `<section class="hc-panel" style="padding:0;background:none"><div class="hc-panel-h" style="padding:0 4px"><h2>${esc(t('casesTitle'))}</h2></div>${table([[t('colCase')], [t('colState')], [t('colTotal'), 'is-r'], [t('colOffer')], [t('colPayment')]], caseRows, t('noCases'))}</section>`;
  const legacy = panel(esc(t('legacyTitle')), `<p>${esc(t('legacyText'))}</p><form class="hc-form" data-form="legacy-revoke">${field(t('legacyAccount'), `<select class="hd-input" name="username" required><option value="">${esc(t('chooseAccount'))}</option><option value="owner">${esc(t('legacyOwner'))}</option><option value="staff">${esc(t('legacyStaff'))}</option></select>`)}${check('reviewed', t('confirmLegacy'))}<div class="hd-actions">${button(t('rotate'), { variant: 'danger', type: 'submit' })}</div></form>`);
  const prepare = panel(esc(t('prepTitle')), b.active_connection_id && candidates.length && active ? `<form class="hc-form" data-form="handover">
      <div class="hc-fields">${field(t('fromA'), `<input class="hd-input" value="${esc(runtimeName(connections.find(c => c.id === b.active_connection_id)))}" readonly>`)}${field(t('toB'), `<select class="hd-input" name="target_connection_id" required><option value="">${esc(t('chooseB'))}</option>${candidates.map(c => `<option value="${esc(c.id)}">${esc(runtimeName(c))}${proofCurrent(b, c) ? '' : esc(t('noProof'))}</option>`).join('')}</select>`)}</div>
      <div><h3 class="hc-small hc-muted" style="margin-bottom:8px">${esc(t('accessTitle'))}</h3>${external.length ? external.map((system, index) => `<fieldset data-external-system="${esc(system.id)}" class="hc-panel" style="border:1px solid var(--line);padding:16px;margin:0 0 8px"><legend class="hc-small" style="font-weight:500">${esc(system.name || system.id)}</legend><div class="hc-fields">${field(t('accessState'), `<select class="hd-input" name="external_state_${index}" required><option value="revocation_pending">${esc(t('stPending'))}</option><option value="verified_revoked">${esc(t('stRevoked'))}</option><option value="uncertain_write">${esc(t('stUncertain'))}</option></select>`)}${field(t('accessEvidence'), `<input class="hd-input" name="external_evidence_${index}" required maxlength="4000" placeholder="${esc(t('accessPh'))}">`)}</div></fieldset>`).join('') : check('native_only', t('nativeOnly'))}</div>
      ${check('reviewed', t('confirmHandover'))}<div class="hd-actions">${button(t('prepare'), { type: 'submit' })}</div>
      ${tech(meta([['Epoch', esc(b.execution_epoch)], ['Rulebook hash', esc(active.payload_hash), true], ['A', esc(b.active_connection_id), true]]))}</form>` : `<p class="hc-empty">${esc(t('prepNeeds'))}</p>`);
  const saved = panel(esc(t('savedTitle')), handoffs.length ? `<ul class="hc-list">${handoffs.map(item => `<li style="flex-direction:column;align-items:stretch"><div class="hc-row" style="justify-content:space-between"><strong>${esc(runtimeName(connections.find(c => c.id === (item.source_id || item.source_connection_id))))} → ${esc(runtimeName(connections.find(c => c.id === (item.target_id || item.target_connection_id))))}</strong>${chip(item.state)}</div>${list(item.external_access).map(access => `<div class="hc-row"><span class="hc-small">${esc(access.system_id)}</span>${chip(access.state)}</div>`).join('')}${item.state === 'prepared' ? `<form class="hc-form" data-form="handover-commit" data-handoff="${esc(item.id)}">${check('reviewed', t('confirmCommit'))}<div class="hd-actions">${button(t('commit'), { type: 'submit' })}</div></form>` : item.state !== 'committed' ? `<p class="hc-small hc-muted">${esc(t('notFinished'))}</p>` : ''}${tech(meta([['ID', esc(item.id), true], ['Epoch', esc(item.expected_epoch)], ['Rulebook hash', esc(item.rulebook_hash), true]]))}</li>`).join('')}</ul>` : `<p class="hc-empty">${esc(t('noHandoffs'))}</p>`);
  return `${stats}${flow}${casesPanel}${prepare}<div class="hc-grid">${legacy}${saved}</div>`;
}

// ---------- events ----------
function setTab(tab) { state.tab = tab; state.feedback = null; history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`); render(); document.querySelector('#main')?.focus(); }
globalThis.addEventListener?.('hashchange', () => { const tab = location.hash.slice(1); if (TABS.includes(tab) && tab !== state.tab) { state.tab = tab; render(); } });
document.addEventListener('change', event => { if (event.target.id === 'business-select') { state.businessId = event.target.value; render(); } });
document.addEventListener('click', async event => {
  const target = event.target.closest('button'); if (!target || state.busy) return;
  if (target.dataset.lang) { state.lang = target.dataset.lang; storage.set('handle.lang', state.lang); render(); return; }
  if (target.dataset.tab) { setTab(target.dataset.tab); return; }
  if (target.dataset.auth) { state.authMode = target.dataset.auth; state.feedback = null; render(); return; }
  if (target.dataset.auditVersion) { state.auditVersion = Number(target.dataset.auditVersion); render(); return; }
  if (target.dataset.approval && !target.closest('form')) { openApproval(target.dataset.approval); return; }
  if (target.dataset.action === 'close-dialog') { event.preventDefault(); dialog.close(); return; }
  if (target.dataset.action === 'copy-agent-card-prompt') { await copySetupPrompt(target); return; }
  if (target.dataset.action === 'copy-customer-prompt') { await copySetupPrompt(target, 'customer'); return; }
  if (target.dataset.action === 'select-agent-card-prompt') { const input = dialog.querySelector('[data-agent-card-prompt]'); input?.focus(); input?.select(); return; }
  if (target.dataset.action === 'refresh') { state.feedback = null; await load(); return; }
  if (target.dataset.action === 'verify-website') { state.busy = true; try { await verifyWebsite(target.dataset.request); } catch (error) { state.feedback = { tone: 'bad', text: error.message }; render(); } finally { state.busy = false; } return; }
  if (target.dataset.action === 'logout') {
    state.busy = true;
    try { await api('/owner/logout', {}); state.owner = null; state.csrf = ''; state.dashboard = { businesses: [], requests: [] }; state.feedback = { tone: 'ok', text: t('msg.logout') }; render(); }
    catch (error) { state.feedback = { tone: 'bad', text: error.message }; render(); }
    finally { state.busy = false; }
  }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('form[data-form]'); if (!form) return; event.preventDefault(); if (state.busy) return;
  const kind = form.dataset.form, data = new FormData(form), current = business(), submitter = event.submitter;
  if (kind === 'consent' && submitter?.value === 'rejected' && !data.get('user_code')) { state.feedback = { tone: 'bad', text: t('msg.rejectNeedsCode') }; render(); return; }
  state.busy = true; const buttons = [...form.querySelectorAll('button')]; buttons.forEach(item => item.disabled = true);
  let message = t('saved'), rotated = null;
  try {
    if (kind === 'login' || kind === 'signup') {
      const account = { email: data.get('email'), password: data.get('password'), ...(kind === 'signup' ? { setup_secret: data.get('setup_secret') } : {}) };
      form.querySelectorAll('input[type=password], input[name=setup_secret]').forEach(input => input.value = '');
      try { await api(`/owner/${kind}`, account); } finally { account.password = ''; if ('setup_secret' in account) account.setup_secret = ''; }
      message = t(`msg.${kind}`);
    } else if (kind === 'consent') {
      if (submitter?.value !== 'rejected' && !consentReady(list(state.dashboard.requests).find(request => (request.id || request.request_id) === form.dataset.request))) throw new Error(t('errors.OWNERSHIP_PROOF_REQUIRED'));
      await api(`/owner/onboarding/${encodeURIComponent(form.dataset.request)}/decide`, { user_code: data.get('user_code'), decision: submitter?.value || 'approved', scopes: data.getAll('scopes') });
      message = submitter?.value === 'rejected' ? t('msg.consentNo') : t('msg.consentOk');
    } else if (!current) throw new Error(t('msg.gone'));
    else {
      const path = value => `/businesses/${encodeURIComponent(current.id)}/owner/${value}`;
      if (kind === 'answer') { await api(path(`questions/${encodeURIComponent(form.dataset.version)}/${encodeURIComponent(form.dataset.question)}/answer`), { answer: data.get('answer'), kind: data.get('kind'), scope: data.get('scope'), ...(data.get('valid_until') ? { valid_until: form.dataset.expiryOriginal && Date.parse(String(data.get('valid_until'))) === Date.parse(form.dataset.expiryLocal) ? form.dataset.expiryOriginal : new Date(String(data.get('valid_until'))).toISOString() } : {}) }); message = t('msg.answer'); }
      else if (kind === 'activate') { await api(path(`rulebooks/${encodeURIComponent(form.dataset.version)}/activate`), { payload_hash: form.dataset.hash }); message = t('msg.activate', form.dataset.version); }
      else if (kind === 'approval') { await api(path(`approvals/${encodeURIComponent(form.dataset.approval)}/decide`), { decision: submitter?.value }); message = submitter?.value === 'approved' ? t('msg.approvalOk') : t('msg.approvalNo'); dialog.close(); }
      else if (kind === 'grant') { await api(path(`connections/${encodeURIComponent(form.dataset.connection)}/authorize-operation`), { scopes: data.getAll('scopes'), expected_epoch: current.execution_epoch }); message = t('msg.grant'); }
      else if (kind === 'revoke') { await api(path(`connections/${encodeURIComponent(form.dataset.connection)}/revoke`), {}); message = t('msg.revoke'); }
      else if (kind === 'legacy-revoke') { rotated = await api(path('legacy-access/revoke'), { username: data.get('username') }); message = t('msg.legacy', data.get('username')); }
      else if (kind === 'handover') {
        const externalAccess = [...form.querySelectorAll('[data-external-system]')].map((fieldset, index) => ({ system_id: fieldset.dataset.externalSystem, state: data.get(`external_state_${index}`), evidence: data.get(`external_evidence_${index}`) }));
        const result = await api(path('handoffs'), { source_connection_id: current.active_connection_id, target_connection_id: data.get('target_connection_id'), expected_epoch: current.execution_epoch, rulebook_hash: activeRules(current)?.payload_hash, external_access: externalAccess });
        message = result.state === 'prepared' ? t('msg.handover') : t('msg.handoverBlocked');
      } else if (kind === 'handover-commit') { await api(path(`handoffs/${encodeURIComponent(form.dataset.handoff)}/commit`), {}); message = t('msg.commit'); }
    }
    state.feedback = { tone: 'ok', text: message }; await load();
    if (rotated?.replacement_password) showPassword(rotated);
  } catch (error) { state.feedback = { tone: 'bad', text: error.message }; if (dialog.open) dialog.close(); if (['OWNERSHIP_PROOF_REQUIRED', 'ONBOARDING_UNAVAILABLE'].includes(error.code)) await load(); else render(); }
  finally { state.busy = false; buttons.forEach(item => { if (item.isConnected) item.disabled = item.dataset.ownershipBlocked === 'true'; }); }
});
function showPassword(rotated) {
  dialog.innerHTML = `<div class="hd-dlg"><div><h2 id="dialog-title">${esc(t('passwordTitle'))}</h2></div><div class="hd-dlg-b"><p>${esc(t('passwordText'))}</p>${field(t('newPw'), '<input class="hd-input is-mono" type="password" readonly autocomplete="off" data-password>')}<p class="hc-small hc-muted" data-evidence></p></div><div class="hd-dlg-f">${button(t('showHide'), { variant: 'secondary', attrs: 'data-show-password' })}${button(t('done'), { attrs: 'data-action="close-dialog"' })}</div></div>`;
  const input = dialog.querySelector('[data-password]'); input.value = rotated.replacement_password; rotated.replacement_password = '';
  dialog.querySelector('[data-evidence]').textContent = rotated.evidence || '';
  dialog.querySelector('[data-show-password]').addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; });
  dialog.addEventListener('close', () => { input.value = ''; dialog.innerHTML = ''; }, { once: true });
  dialog.showModal();
}
// Light/dark follows the system setting; the design system ships both themes.
const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const applyTheme = () => { if (document.documentElement) document.documentElement.dataset.theme = dark?.matches ? 'dark' : 'light'; };
applyTheme(); dark?.addEventListener?.('change', applyTheme);
render();
await load();
