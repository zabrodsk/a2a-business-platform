/* Czech/English switch for the public Pneu 007 pages. Czech markup stays the source of truth;
   English is applied to rendered text, including content that live.js and the design runtime add later. */
const EN = {
  // Titles, navigation and chrome
  'Pneu 007 — Úvod a služby': 'Pneu 007 — Tyre service in Prague 7',
  'Pneu 007 — Kalkulátor ceny': 'Pneu 007 — Price calculator',
  'Pneu 007 — Kontakt': 'Pneu 007 — Contact',
  'Pneu 007 — Podmínky a FAQ': 'Pneu 007 — Terms and FAQ',
  'Pneu 007 — Pro agenty': 'Pneu 007 — For agents',
  'Pneu 007 — Objednání služby': 'Pneu 007 — Book a service',
  'Pneu 007 — úvod': 'Pneu 007 — home',
  'Zelené sportovní kupé na pobřežní silnici': 'Green sports coupé on a coastal road',
  'Hlavní navigace': 'Main navigation', 'Další odkazy': 'More links', 'Patička': 'Footer', 'Obsah stránky': 'On this page',
  'Rychlá kalkulace': 'Quick quote', 'Konfigurace služby': 'Service configuration', 'Cenový souhrn': 'Price summary',
  'Služby': 'Services', 'Kalkulátor': 'Calculator', 'Kontakt': 'Contact', 'Podmínky': 'Terms', 'Objednat': 'Book now',
  'Podmínky a FAQ': 'Terms and FAQ', 'Pro zaměstnance': 'Staff login', 'Pro agenty': 'For agents',
  'Pro agenty — Agent Card': 'For agents — Agent Card', 'Pro agenty · Agent Card': 'For agents · Agent Card',
  'Přihlásit se': 'Sign in', 'Odhlásit': 'Sign out', 'Odhlásit se': 'Sign out', 'Spočítat cenu': 'Get a price',
  'Fiktivní pneuservis pro hackathon.': 'A fictional tyre service built for a hackathon.',
  'Fiktivní pneuservis pro hackathon · servis@pneu007.example': 'A fictional tyre service built for a hackathon · servis@pneu007.example',
  'Testnet platba přes Masumi, bez skutečné autoservisní služby.': 'Testnet payments via Masumi. No real car service is provided.',
  'Testovací platby přes Masumi nebo Link, bez skutečné autoservisní služby.': 'Test payments via Masumi or Link. No real car service is provided.',
  // Home
  'Přezutí · výměna kol · Praha 7 – Holešovice': 'Tyre change · wheel swap · Prague 7 – Holešovice',
  'Připraveni na': 'Ready for', 'další jízdu.': 'the next drive.',
  'Cenu za čtyři kola znáte předem. Termín si vyberete online a zaplatíte rovnou při objednání — zálohu, nebo celou částku.': 'Know the price for all four wheels up front. Pick a slot online and pay when you book — a deposit or the full amount.',
  'Jak to funguje': 'How it works', 'Služba': 'Service', 'Vozidlo': 'Vehicle', 'Disky': 'Rims', 'Průměr': 'Diameter',
  'Cena za 4 kola': 'Price for 4 wheels', 'Upřesnit a objednat': 'Refine and book',
  'Přezutí': 'Tyre change', 'Výměna kol': 'Wheel swap', 'Osobní': 'Car', 'MPV · SUV · 4×4': 'MPV · SUV · 4×4', 'Dodávka': 'Van',
  'Plech': 'Steel', 'Alu': 'Alloy', 'Ověřuji cenu…': 'Checking price…',
  'Bez runflat a TPMS · upřesníte v kalkulátoru': 'Without runflat and TPMS · refine in the calculator',
  'Průměr cenu výměny nemění': 'Diameter does not affect the wheel swap price',
  'Kalkulace není dostupná.': 'Pricing is not available.',
  'Dvě služby.': 'Two services.', 'Jedna péče.': 'One standard of care.',
  'Pracujeme s vašimi vlastními pneumatikami a koly. Cenu určuje vůz a konfigurace kol — nic dalšího se nepřičítá.': 'We work with your own tyres and wheels. The price depends on the car and wheel configuration — nothing else is added.',
  '01 · Přezutí': '01 · Tyre change', '02 · Výměna kol': '02 · Wheel swap', 'od': 'from', 'Kč': 'CZK',
  'Přezutí pneumatik': 'Tyre change', 'Výměna kompletních kol': 'Complete wheel swap',
  'Přezujeme vaše pneumatiky na disky a kola namontujeme na vůz. Cenu ovlivní vůz, průměr, disky, runflat a TPMS.': 'We fit your tyres onto the rims and mount the wheels on your car. The price depends on the car, diameter, rims, runflat and TPMS.',
  'Spočítat přezutí': 'Price a tyre change',
  'Máte druhou sadu kol na discích? Vyměníme je. Cenu ovlivní jen typ vozu a materiál disku.': 'Have a second set of wheels on rims? We swap them. Only the vehicle type and rim material affect the price.',
  'Spočítat výměnu': 'Price a wheel swap', 'V ceně obou služeb': 'Included in both services',
  'Montáž kol na vozidlo': 'Mounting the wheels on the car', 'Mytí kol': 'Wheel wash', 'Vyvážení a nahuštění': 'Balancing and inflation',
  'Ošetření dosedacích ploch': 'Hub contact surface care', 'Dotažení předepsaným momentem': 'Tightening to the specified torque',
  'Přezutí navíc zahrnuje demontáž a montáž pneumatik na disky.': 'A tyre change also includes removing and fitting the tyres on the rims.',
  'Čtyři kroky': 'Four steps', 'k termínu.': 'to your appointment.', 'Konfigurace': 'Configuration',
  'Vůz, služba, průměr a disky, runflat a TPMS.': 'Car, service, diameter and rims, runflat and TPMS.', 'Cena': 'Price',
  'Všechny položky a konečná cena za čtyři kola.': 'Every line item and the final price for four wheels.', 'Termín a platba': 'Slot and payment',
  'Vyberete volný slot a zaplatíte zálohu 500 Kč, nebo celou cenu.': 'Choose a free slot and pay a 500 CZK deposit or the full price.',
  'Potvrzení': 'Confirmation', 'Po ověření platby je termín váš. Stav sledujete online.': 'Once the payment is verified, the slot is yours. Track the status online.',
  'Záloha je součástí ceny.': 'The deposit is part of the price.',
  'U ceny 2 472 Kč zaplatíte 500 Kč předem a 1 972 Kč při návštěvě. Nebo vše najednou.': 'For a 2 472 CZK service you pay 500 CZK up front and 1 972 CZK at the visit. Or everything at once.',
  'Spočítat a objednat': 'Price and book',
  'Pneumatická 7, 170 00 Praha 7 – Holešovice': 'Pneumatická 7, 170 00 Prague 7 – Holešovice',
  // Calculator
  'Cena za čtyři kola': 'Price for four wheels',
  'Každá změna se přepočítá okamžitě. Objednáte a zaplatíte v dalším kroku.': 'Every change is recalculated instantly. You book and pay in the next step.',
  'Vymazat volby': 'Clear choices', 'Načíst demo konfiguraci': 'Load demo configuration',
  '1. Typ vozidla': '1. Vehicle type', '× Vyberte typ vozidla.': '× Choose a vehicle type.', '2. Služba': '2. Service', '× Vyberte službu.': '× Choose a service.',
  '3. Průměr disku': '3. Rim diameter', '× Vyberte průměr disku (13″–22″).': '× Choose a rim diameter (13″–22″).',
  'U výměny kompletních kol průměr zaznamenáme, cenu ale nemění.': 'For a complete wheel swap we record the diameter, but it does not change the price.',
  '4. Materiál disku': '4. Rim material', '× Vyberte plechové, nebo hliníkové disky.': '× Choose steel or alloy rims.',
  '5. Runflat': '5. Runflat', 'Pneumatika umožňující omezený dojezd po ztrátě tlaku.': 'A tyre that can keep driving a limited distance after losing pressure.',
  '× Uveďte, zda jde o runflat.': '× Say whether the tyres are runflat.', '6. TPMS': '6. TPMS', 'Systém sledování tlaku v pneumatikách.': 'Tyre pressure monitoring system.',
  '× Uveďte, zda vůz má TPMS.': '× Say whether the car has TPMS.',
  'Runflat a TPMS u výměny kompletních kol evidujeme pro servisní tým. Cenu této služby nemění.': 'For a complete wheel swap we record runflat and TPMS for the service team. They do not change the price.',
  'Cena je konečná. Další daň ani poplatky se nepřičítají.': 'The price is final. No extra tax or fees are added.',
  'Cena zatím není k dispozici': 'Price not available yet', 'Doplňte chybějící volby:': 'Complete the missing choices:',
  'Celkem za 4 kola': 'Total for 4 wheels', '· celkem za 4 kola': '· total for 4 wheels', 'Obsah služby': 'What is included', 'Objednat službu': 'Book the service',
  'Dále vyberete termín a zaplatíte': 'Next, pick a slot and pay', 'Nezávazná poptávka': 'Non-binding enquiry',
  'Nejdřív doplňte chybějící volby': 'Complete the missing choices first',
  'Osobní auto': 'Passenger car', 'MPV, SUV, 4×4': 'MPV, SUV, 4×4', 'Plechové': 'Steel', 'Hliníkové (alu)': 'Alloy',
  'Ne': 'No', 'Ano': 'Yes', 'bez vlivu': 'no effect', 'cenu výměny nemění': 'no effect on swap price',
  'Typ vozidla': 'Vehicle type', 'Průměr disku': 'Rim diameter', 'Materiál disku': 'Rim material', 'Runflat': 'Runflat', 'TPMS': 'TPMS',
  'Ověřuji cenu na serveru…': 'Checking the price on the server…', 'Demontáž a montáž pneumatik na disky': 'Removing and fitting tyres on the rims',
  'Vyvážení': 'Balancing', 'Nahuštění': 'Inflation', 'SUV / MPV / 4×4': 'SUV / MPV / 4×4', 'Plechové disky': 'Steel rims', 'Hliníkové disky': 'Alloy rims',
  // Contact
  'Navštivte nás v Holešovicích': 'Visit us in Holešovice',
  'Pneu 007 je fiktivní pneuservis pro hackathon.': 'Pneu 007 is a fictional tyre service built for a hackathon.',
  'Na uvedené testovací adrese se autoservisní služby neposkytují.': 'No car services are provided at this demo address.',
  'Adresa': 'Address', 'Telefon': 'Phone', 'E-mail': 'Email', 'Web': 'Website', 'Vedoucí provozovny': 'Branch manager', 'Hlavní technik': 'Head technician',
  'Veřejný profil a Agent Card': 'Public profile and Agent Card',
  'Testovací e-mail nepřijímá skutečnou poštu. V prototypu se neodesílají e-maily ani SMS.': 'The demo mailbox does not receive real mail. The prototype sends no emails or text messages.',
  'Provozní doba': 'Opening hours', 'Ukázková provozní doba fiktivní provozovny.': 'Sample opening hours of a fictional workshop.',
  'Pondělí – pátek': 'Monday – Friday', 'Sobota': 'Saturday', 'Neděle': 'Sunday', 'Zavřeno': 'Closed', 'Státní svátky': 'Public holidays',
  '· termín na svátek potvrdíme individuálně': '· holiday bookings confirmed individually',
  'Orientační informace': 'Getting here',
  'Přivezte vlastní pneumatiky nebo kompletní kola, která chcete namontovat.': 'Bring your own tyres or complete wheels that you want fitted.',
  'Mějte po ruce číslo objednávky, například': 'Have your order number ready, for example',
  'Příjezd a parkování: vlastní parkoviště pro šest vozů přímo před dílnou, vjezd z ulice Pneumatická.': 'Arrival and parking: private parking for six cars right in front of the workshop, entrance from Pneumatická street.',
  'Veřejná doprava: tramvaj č. 7, zastávka Pneumatická, odtud dvě minuty pěšky.': 'Public transport: tram no. 7 to the Pneumatická stop, then a two-minute walk.',
  'Orientační plánek': 'Location map', 'Pneumatická 7, Praha 7 – Holešovice': 'Pneumatická 7, Prague 7 – Holešovice',
  'Ilustrační plánek fiktivní provozovny, nejde o skutečnou mapu.': 'Illustrative map of a fictional workshop, not a real map.',
  // Terms
  'Obsah': 'Contents', 'Vlastní pneumatiky': 'Your own tyres', 'Co obsahuje cena': 'What the price includes', 'Záloha a doplatek': 'Deposit and balance',
  'Potvrzení termínu': 'Slot confirmation', 'Testovací platby': 'Test payments', 'Storno a refund': 'Cancellation and refunds', 'Časté otázky': 'FAQ',
  'Jak služba funguje': 'How the service works',
  'Shrnutí pravidel pro objednání u fiktivního pneuservisu Pneu 007. Ukázkové podmínky fiktivní provozovny.': 'A summary of the booking rules at the fictional Pneu 007 tyre service. Sample terms of a fictional workshop.',
  'Vlastní pneumatiky zákazníka': 'Customer’s own tyres',
  'Objednáváte práci na pneumatikách a kolech, které přivezete. Pneumatiky ani disky v objednávce nekupujete.': 'You book work on tyres and wheels that you bring. Tyres and rims are not sold with the order.',
  'Všechny ceny jsou za čtyři kola.': 'All prices are for four wheels.',
  'Příplatky za typ vozu, průměr, disky, runflat a TPMS se přičítají jednou k celku.': 'Surcharges for vehicle type, diameter, rims, runflat and TPMS are added once to the total.',
  'Cena z kalkulátoru je konečná. Další daň ani poplatek nepřičítáme.': 'The calculator price is final. We add no further tax or fees.',
  'Obě služby zahrnují montáž kol na vozidlo, mytí, vyvážení, nahuštění, ošetření dosedacích ploch a dotažení předepsaným momentem. Přezutí navíc zahrnuje demontáž a montáž pneumatik na disky.': 'Both services include mounting the wheels, washing, balancing, inflation, hub surface care and tightening to the specified torque. A tyre change also includes removing and fitting the tyres on the rims.',
  'Záloha 500 Kč je součástí celkové ceny, nepřičítá se k ní. Při objednání si vyberete zálohu, nebo plnou úhradu, pokud je pro daný termín povolená.': 'The 500 CZK deposit is part of the total price, not added to it. When booking you choose a deposit or full payment, if allowed for that slot.',
  'Příklad': 'Example', 'Celková cena': 'Total price', 'Platíte nyní': 'Pay now', 'Doplatek': 'Balance',
  'Přezutí, osobní auto, 18″, alu — záloha': 'Tyre change, passenger car, 18″, alloy — deposit', 'Totéž — plná úhrada': 'Same — full payment',
  'Doplatek uhradíte na místě po provedení služby, kartou nebo hotově.': 'You pay the balance on site after the service, by card or in cash.',
  'Termín dočasně blokován': 'Slot temporarily held', '— po výběru slotu jej na omezenou dobu držíme. Zbývající čas určuje systém rezervací.': '— after you pick a slot we hold it for a limited time. The booking system sets the remaining time.',
  'Platba čeká na ověření': 'Payment awaiting verification', '— kliknutí na tlačítko platby ještě neznamená zaplaceno.': '— clicking the payment button does not yet mean it is paid.',
  'Rezervace potvrzena': 'Booking confirmed', '— po ověření platby. Teprve tehdy je termín váš.': '— after the payment is verified. Only then is the slot yours.',
  'Služba provedena': 'Service completed', '— až po fyzickém provedení v provozovně. Potvrzená rezervace ještě není provedené přezutí.': '— only after the work is physically done at the workshop. A confirmed booking is not a completed tyre change.',
  'Testnet platba, bez skutečné autoservisní služby.': 'Testnet payment, no real car service.',
  'Platby probíhají přes Masumi na síti Cardano Preprod v test-ADA. Nejde o platbu v korunách.': 'Payments run through Masumi on the Cardano Preprod network in test-ADA. They are not payments in Czech crowns.',
  'Cena služby je v Kč. Testnet částka v test-ADA je samostatný údaj a uvidíte ji před potvrzením.': 'The service price is in CZK. The testnet amount in test-ADA is shown separately before you confirm.',
  'Přepočet Kč → test-ADA podle demo mapování: 100 Kč odpovídá 1 test-ADA, záloha 500 Kč tedy 5 test-ADA. Maximální síťový poplatek uvidíte a schválíte před potvrzením.': 'CZK → test-ADA demo mapping: 100 CZK equals 1 test-ADA, so the 500 CZK deposit is 5 test-ADA. You see and approve the maximum network fee before confirming.',
  'Prostředky nejdřív leží v escrow. Výplata provozovateli je samostatný krok.': 'Funds are held in escrow first. Payout to the workshop is a separate step.',
  'Pokud výsledek platby není jasný, neplaťte znovu. Stav ověříme a zobrazíme na stránce objednávky.': 'If the payment result is unclear, do not pay again. We verify the status and show it on the order page.',
  'Storno.': 'Cancellation.', 'Termín můžete zdarma zrušit nejpozději 24 hodin předem. Při pozdějším zrušení nebo nedostavení se záloha nevrací.': 'You can cancel free of charge up to 24 hours before the slot. Later cancellations or no-shows forfeit the deposit.',
  'Refund.': 'Refunds.', 'Oprávněný refund schválíme do 3 pracovních dnů a vrátíme jej stejnou platební metodou, jakou jste platili.': 'We approve eligible refunds within 3 working days and return them to the payment method you used.',
  'Ukázkové podmínky fiktivního pneuservisu. Stavy refundu (požadován, probíhá, ověřen) uvidíte na stránce objednávky.': 'Sample terms of a fictional tyre service. Refund states (requested, in progress, verified) appear on the order page.',
  'Je záloha navíc k ceně?': 'Is the deposit charged on top of the price?', 'Ne. Záloha 500 Kč je část celkové ceny. U ceny 2 472 Kč doplácíte 1 972 Kč.': 'No. The 500 CZK deposit is part of the total. For a 2 472 CZK service you pay a balance of 1 972 CZK.',
  'Kdy je termín jistý?': 'When is my slot guaranteed?', 'Až ve stavu „Rezervace potvrzena“. Dočasné blokování termínu ani odeslání platby rezervaci nepotvrzuje.': 'Only in the “Booking confirmed” state. A temporary hold or a submitted payment does not confirm the booking.',
  'Mění průměr kola cenu výměny kompletních kol?': 'Does wheel diameter change the wheel swap price?', 'Ne. U výměny průměr, runflat a TPMS jen zaznamenáme. Cenu mění typ vozu a materiál disku.': 'No. For a swap we only record diameter, runflat and TPMS. Vehicle type and rim material set the price.',
  'Může za mě objednat AI agent?': 'Can an AI agent book for me?', 'Ano, v mezích mandátu, který mu zadáte. Podporované služby a vstupy najde agent na stránce': 'Yes, within the mandate you give it. The agent finds supported services and inputs on the page',
  // For agents
  'Veřejný profil Pneu 007': 'Pneu 007 public profile',
  'Pro AI agenty, kteří jednají jménem zákazníka. Popisuje, co lze u Pneu 007 objednat a jaké vstupy agent potřebuje. Technický Agent Card je níže.': 'For AI agents acting on behalf of a customer. Describes what can be booked at Pneu 007 and which inputs an agent needs. The technical Agent Card is below.',
  'Ověřuji stav agenta…': 'Checking agent status…', 'Stav čteme z publikovaného Agent Card.': 'Status is read from the published Agent Card.',
  'Ověřeno z publikovaného Agent Card.': 'Verified from the published Agent Card.', 'Agent je dočasně nedostupný': 'Agent temporarily unavailable',
  'Agent Card se zobrazí po aktivaci schválených pravidel.': 'The Agent Card appears once approved rules are activated.',
  'Podporované schopnosti': 'Supported capabilities', 'Kalkulace ceny': 'Price calculation',
  'Běžná cena za čtyři kola podle veřejného ceníku. Vrací položky a celkovou cenu v Kč.': 'Standard price for four wheels from the public price list. Returns line items and the total in CZK.',
  'Nabídka a termín': 'Quote and slot', 'Závazná nabídka s omezenou platností a dočasné blokování volného termínu.': 'A binding quote with limited validity and a temporary hold on a free slot.',
  'Testovací platba': 'Test payment', 'Záloha 500 Kč, nebo plná úhrada přes Masumi na síti Cardano Preprod. Bez skutečné služby.': 'A 500 CZK deposit or full payment via Masumi on Cardano Preprod. No real service.',
  'Stav objednávky': 'Order status', 'Odděleně stav objednávky, platby a provedení služby.': 'Separate status for the order, payment and service completion.',
  'Požadované vstupy': 'Required inputs', 'Vstup': 'Input', 'Hodnoty': 'Values', 'přezutí · výměna kompletních kol': 'tyre change · complete wheel swap',
  'osobní auto · MPV, SUV, 4×4 · dodávka': 'passenger car · MPV, SUV, 4×4 · van', '13″ až 22″': '13″ to 22″', 'plechové · hliníkové': 'steel · alloy',
  'Runflat, TPMS': 'Runflat, TPMS', 'ano · ne': 'yes · no', 'Termín': 'Slot', 'preferované okno, časové pásmo Europe/Prague': 'preferred window, Europe/Prague time zone',
  'e-mail, telefon, provozovna (povinné); jméno': 'email, phone, workshop (required); name', 'Platba': 'Payment', 'záloha, nebo plná úhrada, je-li povolená': 'deposit, or full payment if allowed',
  'Mimo rozsah': 'Out of scope', 'Prodej pneumatik, disků a dílů': 'Selling tyres, rims or parts', 'Uskladnění kol': 'Wheel storage',
  'Jiné služby než dvě uvedené': 'Services other than the two listed', 'Platby na mainnetu nebo v korunách': 'Mainnet or Czech-crown payments',
  'Agent jedná v mezích mandátu zákazníka. Doporučení nevytváří nákup ani rezervaci. Rezervace platí až po ověření platby.': 'The agent acts within the customer’s mandate. A recommendation creates no purchase or booking. A booking holds only after the payment is verified.',
  'Agent fiktivního pneuservisu Pneu 007 v Holešovicích. Pošlete požadavek v běžném textu, agent se doptá a nabídku dokončí.': 'Agent of the fictional Pneu 007 tyre service in Holešovice. Send a plain-text request; the agent asks follow-up questions and completes the quote.',
  'Protokol': 'Protocol', 'Autentizace': 'Authentication', 'Bearer token po propojení se zákazníkem': 'Bearer token after linking with a customer',
  'Bearer token · propojení potvrzuje přihlášený zákazník': 'Bearer token · a signed-in customer confirms the link', 'Demo konverzace bez přihlášení · nákup potvrzuje zákazník': 'Demo chats need no login · purchases need customer approval',
  'Dovednosti': 'Skills', 'Vstupy a výstupy': 'Inputs and outputs', 'Verze': 'Version', 'Otevřít Agent Card': 'Open Agent Card', 'Jak propojit agenta': 'How to connect an agent',
  'Načítám publikovaný Agent Card…': 'Loading the published Agent Card…', 'Agent Card neobsahuje interní pravidla, soukromá data ani klíče.': 'The Agent Card contains no internal rules, private data or keys.',
  // Order and checkout (live.js)
  'Načítání objednávky…': 'Loading order…', 'Načítání…': 'Loading…', 'Načítání kalkulace…': 'Loading quote…', 'Objednání služby': 'Book a service',
  'Kontakt a termín': 'Contact and slot', 'Souhrn a autorizace': 'Summary and authorisation', 'Konfigurace z kalkulátoru': 'Configuration from the calculator',
  'Uskladnění, prodej pneumatik a dílů nejsou součástí služby.': 'Storage and sale of tyres or parts are not part of the service.',
  'Upravit konfiguraci': 'Edit configuration', 'Počet kol': 'Number of wheels', '4 · vlastní pneumatiky': '4 · customer’s own tyres', 'Runflat / TPMS': 'Runflat / TPMS', 'Pokračovat na kontakt a termín': 'Continue to contact and slot', 'Jméno a příjmení': 'Full name',
  'Volný termín · Europe/Prague': 'Free slot · Europe/Prague', 'Momentálně není volný termín. Odešlete nezávaznou poptávku.': 'No free slot right now. Send a non-binding enquiry.',
  'Výběr termínu jej zatím neblokuje. Dostupnost se znovu ověří při nákupu.': 'Selecting a slot does not hold it yet. Availability is re-checked at purchase.',
  'Zpět': 'Back', 'Zobrazit souhrn': 'Show summary', 'Souhrn objednávky': 'Order summary', 'Platební metoda': 'Payment method', 'Režim úhrady': 'Payment mode',
  'Částka nyní': 'Amount now', 'Doplatek po záloze': 'Balance after deposit', 'Pro závazný nákup se přihlaste zákaznickým účtem.': 'Sign in with a customer account to make a binding purchase.',
  'Tento účet není zákaznický. Nákup vyžaduje vlastní zákaznický účet.': 'This is not a customer account. Purchases require a customer account.',
  'Autorizovat a koupit službu': 'Authorise and buy the service', 'Zpracování…': 'Processing…', 'Zaplatit přes Link / kartou': 'Pay with Link / card',
  'Celkem za 4 kola ': 'Total for 4 wheels ', 'Konečná cena služby v Kč. Testovací síťová transakce se eviduje samostatně.': 'Final service price in CZK. The test network transaction is recorded separately.',
  'Lokální testovací platba': 'Local test payment', 'Masumi · test-ADA v escrow': 'Masumi · test-ADA in escrow', 'Link / karta · testovací platba v Kč': 'Link / card · test payment in CZK',
  'Lokální simulace · bez on-chain transakce': 'Local simulation · no on-chain transaction',
  'Testovací platba, bez skutečné autoservisní služby. Cena v Kč není skutečná korunová platba. Escrow se eviduje odděleně od výplaty prodejci.': 'Test payment, no real car service. The CZK price is not a real crown payment. Escrow is recorded separately from the seller payout.',
  'Technické podmínky testovací platby': 'Technical terms of the test payment', 'Stav objednávky ': 'Order status ',
  'Služba a rezervace': 'Service and booking', 'Uložený kontakt': 'Saved contact', 'Objednávka': 'Order', 'Rezervace': 'Booking', 'Fyzická služba': 'Physical service',
  'Doplatek v Kč': 'Balance in CZK', 'Dosud nepotvrzena': 'Not yet confirmed', 'Dosud neprovedena': 'Not yet done', 'Provedena': 'Done', 'Stáhnout do kalendáře': 'Add to calendar',
  'Potvrzená rezervace neznamená provedené přezutí.': 'A confirmed booking does not mean the tyre change is done.', 'Nákup ještě nebyl autorizován': 'Purchase not yet authorised',
  'Prostředky v escrow': 'Funds in escrow', 'Výplata prodejci': 'Seller payout', 'Síťová částka': 'Network amount', 'Dosud neověřeny': 'Not yet verified', 'Dosud neověřena': 'Not yet verified',
  'Ověřena': 'Verified', 'Ověřit aktuální stav': 'Check current status', 'Ověřování…': 'Checking…', 'Koupit službu': 'Buy the service', 'Zaplatit zálohu přes Link': 'Pay deposit with Link',
  'Nejasný stav vyžaduje kontrolu; platbu znovu nespouštějte naslepo.': 'An unclear status needs checking; do not retry the payment blindly.', 'Technické detaily platby': 'Technical payment details',
  'Uložená objednávka a rezervace': 'Saved order and booking', 'Zkusit znovu': 'Try again', 'Platba přes Link / kartou': 'Payment with Link / card', 'Pokračovat v Link / kartou': 'Continue with Link / card',
  'Platba vytvořena': 'Payment created', 'Nákup požadován, čeká na ověření': 'Purchase requested, awaiting verification', 'Prostředky v escrow ': 'Funds in escrow ',
  'Výsledek předán, čeká na vypořádání': 'Result delivered, awaiting settlement', 'Výplata prodejci ověřena': 'Seller payout verified', 'Refund požadován': 'Refund requested',
  'Refund ověřen': 'Refund verified', 'Platba selhala': 'Payment failed', 'Nejasný stav, nutná kontrola': 'Unclear state, check required',
  // Dialogs (live.js)
  'Přihlášení': 'Sign in', 'Pro nákup použijte zákaznický účet. Demo přístupové údaje jsou v místním návodu projektu.': 'Use a customer account to buy. Demo credentials are in the project’s local guide.',
  'Uživatelské jméno': 'Username', 'Heslo': 'Password', 'Přihlásit': 'Sign in', 'Zavřít': 'Close', 'Váš účet': 'Your account',
  'Konfigurace z kalkulátoru se odešle do pneuservisu. Tento krok nerezervuje termín ani nespouští platbu.': 'The calculator configuration is sent to the workshop. This step books no slot and starts no payment.',
  'Jméno': 'Name', 'Provozovna': 'Workshop', 'Odeslat poptávku': 'Send enquiry', 'Poptávka přijata': 'Enquiry received', 'Autorizace nákupu': 'Purchase authorisation',
  'Režim': 'Mode', 'Záloha 500 Kč': 'Deposit 500 CZK', 'Plná úhrada': 'Full payment', 'Autorizovat a koupit': 'Authorise and buy',
};
const PATTERNS = [
  [/^Přihlášeno jako (.+)$/, 'Signed in as $1'],
  [/^základ (.+?)\s?Kč$/, 'base $1 CZK'],
  [/^× Chybí: (.+)$/, (m, label) => `× Missing: ${EN[label] ?? label}`],
  [/^Vozidlo: (.+)$/, (m, v) => `Vehicle: ${EN[v] ?? v}`],
  [/^Disky: (.+)$/, (m, v) => `Rims: ${(EN[v[0].toUpperCase() + v.slice(1)] ?? v).toLowerCase()}`],
  [/^Průměr (\d+″)$/, 'Diameter $1'],
  [/^(Ano|Ne) \/ (Ano|Ne)$/, (m, a, b) => `${a === 'Ano' ? 'Yes' : 'No'} / ${b === 'Ano' ? 'Yes' : 'No'}`],
  [/^(Runflat|TPMS): (ano|ne)$/, (m, k, v) => `${k}: ${v === 'ano' ? 'yes' : 'no'}`],
  [/^(.+) · celkem za 4 kola$/, (m, v) => `${EN[v] ?? v} · total for 4 wheels`],
  [/^Objednání služby · krok (\d) ze 3$/, 'Booking · step $1 of 3'],
  [/^Objednávka (.+)$/, 'Order $1'],
  [/^Záloha ([\d\s  ,]+\s?Kč)$/, 'Deposit $1'],
  [/^Plná úhrada ([\d\s  ,]+\s?Kč)(.*)$/, 'Full payment $1$2'],
  [/^Termín:$/, 'Slot:'],
  [/^([+−-]?[\d\s  ]+(?:,\d+)?)\s?Kč$/, '$1 CZK'],
];
const ATTRS = ['aria-label', 'alt', 'title', 'placeholder'];
const original = new WeakMap(), originalAttr = new WeakMap();
let lang = 'cs';
try { lang = new URLSearchParams(location.search).get('lang') || localStorage.getItem('pneu007-lang') || 'cs'; } catch { /* storage unavailable */ }
if (lang !== 'en') lang = 'cs';

function english(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (!key) return null;
  if (EN[key] !== undefined) return EN[key];
  for (const [pattern, replacement] of PATTERNS) if (pattern.test(key)) return key.replace(pattern, replacement);
  return null;
}
function translateText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest('script,style,.tb,.live-json,[data-no-i18n]')) return;
  const stored = original.get(node);
  const source = stored !== undefined && (node.nodeValue === stored.cs || node.nodeValue === stored.en) ? stored.cs : node.nodeValue;
  if (lang === 'cs') { if (stored && node.nodeValue === stored.en) node.nodeValue = stored.cs; return; }
  const translated = english(source);
  if (translated === null) return;
  const lead = source.match(/^\s*/)[0], trail = source.match(/\s*$/)[0], en = lead + translated + trail;
  original.set(node, { cs: source, en });
  if (node.nodeValue !== en) node.nodeValue = en;
}
function translateAttributes(element) {
  for (const name of ATTRS) {
    if (!element.hasAttribute(name)) continue;
    const saved = originalAttr.get(element) ?? {};
    const value = element.getAttribute(name);
    const source = saved[name] && (value === saved[name].cs || value === saved[name].en) ? saved[name].cs : value;
    const target = lang === 'en' ? english(source) ?? source : source;
    saved[name] = { cs: source, en: lang === 'en' ? target : saved[name]?.en ?? source };
    originalAttr.set(element, saved);
    if (value !== target) element.setAttribute(name, target);
  }
}
function translate(root) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) node.nodeType === Node.TEXT_NODE ? translateText(node) : translateAttributes(node);
}
const titles = { cs: document.title, en: EN[document.title] ?? document.title };
function apply() {
  document.documentElement.lang = lang;
  document.title = titles[lang];
  translate(document.body);
  document.querySelectorAll('.lang-switch button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === lang)));
}
function addSwitch() {
  if (document.querySelector('.lang-switch')) return;
  const session = document.querySelector('header .live-session');
  if (!session) return;
  const group = document.createElement('div');
  group.className = 'lang-switch'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Jazyk / Language'); group.dataset.noI18n = '';
  group.innerHTML = '<button type="button" data-lang="cs" lang="cs">CS</button><button type="button" data-lang="en" lang="en">EN</button>';
  group.addEventListener('click', event => {
    const button = event.target.closest('button[data-lang]'); if (!button || button.dataset.lang === lang) return;
    lang = button.dataset.lang;
    try { localStorage.setItem('pneu007-lang', lang); } catch { /* preference is a convenience only */ }
    apply();
  });
  session.after(group);
}
// The design runtime hydrates the Czech markup; touch the DOM only after it has rendered.
const rendered = () => Boolean(document.querySelector('header[data-dc-tpl]'));
let started = false;
function start() {
  if (started || !rendered()) return;
  started = true;
  // Let the runtime finish its first commit before text is rewritten.
  requestAnimationFrame(() => { addSwitch(); apply(); });
}
new MutationObserver(records => {
  if (!started) return start();
  addSwitch();
  if (lang === 'cs') return;
  for (const record of records) {
    if (record.type === 'characterData') translateText(record.target);
    else if (record.type === 'attributes') translateAttributes(record.target);
    else record.addedNodes.forEach(translate);
  }
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
start();
