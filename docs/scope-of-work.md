# Handle zadání hackathonu verze 2 Final Draft

Handle má na fiktivním pneuservisu Pneu 007 ukázat úplný průchod od fresh firemního GrokBota a existujícího legacy systému až po audit, schválená pravidla, agentem publikovanou Agent Card, skutečné jednání se zákaznickým botem a dokončenou sandboxovou rezervaci. Firemní kontext patří firmě a zůstává zachovaný i při výměně jejího obslužného agenta.

Verze: 2.2, Final Draft\
Aktualizace: 9. října 2026\
Tým: tři lidé\
Demo: Pneu 007, výslovně fiktivní firma\
Kanonická specifikace v repozitáři: `docs/scope-of-work.md`\
Stav: společné finální zadání pro implementaci a ověření. Stav konkrétního buildu a živých integrací dokládají samostatné testovací protokoly.

Přejmenování: od 9. října 2026 se produkt dříve nazývaný Handoru jmenuje **Handle**. Funkční požadavky, identity, pravidla a uložené záznamy zůstávají zachované; původní API/routy a proměnné prostředí jsou kompatibilní aliasy.

### Jak tuto specifikaci používat

Tento soubor je společná produktová a technická reference pro lidi i agenty pracující v repozitáři. Novější výslovné rozhodnutí uživatele má přednost; související změny se promítnou sem a do dotčených testů. Starší plány, prompty, diagramy a popisy implementace nesmějí potichu změnit níže stanovený cílový průchod. Zjištěný rozpor se zaznamená a vyřeší v tomto společném zadání.

Připravené jsou legacy web, backend, dummy provozní data a vstupní dokumenty. Agentí účty, firemní relay, auditní závěry, rulebook a publikace karty pro fresh walkthrough vzniknou až podporovaným onboardingem. Skriptované testovací identity jsou přípustné v automatizovaných testech; živou demonstraci provádějí skuteční GrokBoti na oddělených účtech.

### Závazná produktová rozhodnutí

- Vývojový tým před prvním dnem nasadí Handle s relay enginem, obecnými instrukcemi a ukládáním auditního reportu/důkazů. Audit nepotřebuje vlastní Pneu nebo CRM konektor.
- Majitel začíná s fresh GrokBotem, jedním či více nezávislými legacy systémy a instrukcemi s URL Handle. Bezpečně mu poskytne admin přístupy a známé URL; nepřipravuje relay, audit ani výsledný rulebook.
- GrokBot zahájí registraci a připojení firmy, přes API vyžádá spravovaný relay, provede audit, navrhne pravidla a po lidském schválení publikuje kartu i viditelný odkaz na legacy webu.
- Člověk ověří vlastnictví, poskytne přístupová oprávnění a schválí pravidla, mandáty a případné výjimky. Agent si tato oprávnění neuděluje.
- Pro provoz Pneu 007 doporučujeme vlastní servisní účet každého agenta, vytvořený majitelem nebo automaticky po jeho souhlasu, a tenký Pneu MCP nad stávajícími policy-checkovanými API/doménovými funkcemi. Audit zvláštní konektor nepotřebuje.
- Firemní profil, audit, verzovaný rulebook, lidské souhlasy, napojení a rozpracované případy patří firmě v Handle. Legacy a platební provider zůstávají autoritami pro své skutečné záznamy.
- Výchozí zákaznické discovery používá veřejný registry dodaný skillem `handle-customer`: služba/lokalita → aktivní listing → web a aktuální Agent Card → A2A endpoint. Zákazník nemusí znát URL firmy; přímý známý kontakt zůstává podporovanou alternativou.
- Výměna firemního runtime zachová kontext a platné obchodní vazby. Handle odvolá původní připojení; externí účty a sessions se samostatně odvolají/rotují nebo mají skutečně kontrolovaný přístup. Do vyřešení zůstává předání pending; přijaté serverové platby pokračují pod původní autorizací.

Obchodní částky, termíny a kontakty níže jsou testovací data. Dostupnost vlastností konkrétních runtime, účtů, adaptérů a platebního prostředí se ověřuje samostatně; požadavek není důkazem implementované funkce.

**Aktuální rozhodnutí majitele pro hackathonové demo, 9. října 2026:** platby tohoto průchodu používají pouze `local_demo`, síť `local` a syntetický asset `lovelace`. Záloha je simulovaných 500 Kč, bez blockchainového nákupu, síťového poplatku, skutečného inkasa či on-chain refundu; Stripe se v tomto průchodu nepoužívá. Masumi Preprod není podmínkou onboardingu ani schválení lokálních demo pravidel. Skutečný audit, vlastní doložený návrh pravidel a nezávislé lidské schválení zůstávají povinné; nejde o přepnutí na připravené `open_demo`. Starší audit Masumi a jeho důkazy zůstávají v historii. Agent změnu znovu pozoruje a doloží v aktualizovaném reportu a návrhu s aktuální odpovědí majitele; historické blokace se nemažou ani nevydávají za vyřešené bez nových podkladů. Níže uvedené Masumi scénáře zůstávají samostatným volitelným technickým ověřením, nikoli podmínkou tohoto dema.

## 1. Cíl a definice hotového výsledku

Majitel fiktivního Pneu 007 má fresh GrokBota, existující web a jeden či více nezávislých provozních systémů. Zadá URL Handle, známé adresy systémů a bezpečně poskytne admin účty. GrokBot sám zahájí registraci, požádá o spravovaný relay a provede pozorovací audit veřejného webu a přístupných administrací, existujících zdokumentovaných API/OpenAPI nebo MCP. Uloží obecný report s minimálními důkazními přílohami a navrhne podporovaný rulebook. Majitel se nezávisle přihlásí do Handle, posoudí fakta i autoritu zdrojů a schválí přesnou verzi pravidel a provozní scope. Bot potom dostupným CMS/file managerem/hostingovým UI či existujícím API/MCP publikuje kartu a odkaz v odsouhlaseném rozsahu.

Zákazník zadá svému skutečnému GrokBotovi službu a lokalitu. Skill `handle-customer` dodá registry URL; agent z aktivního listingu získá website/card URL. Agent za běhu načte web a aktuální kartu, bezpečně získá vlastní přístup k deklarované službě a kontaktuje skutečného firemního GrokBota. Vyjedná nabídku a buď ji předloží zákazníkovi, nebo ji přijme v mezích lidsky schváleného mandátu. Firemní agent používá legacy nástroje a aktivní pravidla; výjimku předkládá oprávněnému majiteli. Výsledkem je uložená rezervace a doložený sandboxový platební stav.

### 1.1 První den a role účastníků

| Kdo | Co zajišťuje |
| - | - |
| Vývojový tým před prvním dnem | Handle, HTTPS, persistent storage, identity/consent API, relay engine, report/evidence upload a generování/ověření karty. Pro demo dokumentované Pneu booking/checkout API a Masumi; žádný povinný auditní konektor. |
| Majitel | Fresh GrokBot, URL a admin přístupy k nezávislým systémům, samostatnou lidskou Handle autentizaci, potvrzení firmy a rozsahu, přezkum auditu a lidská rozhodnutí. První Handle účet vznikne při tomto consentu. |
| Firemní GrokBot | Registraci, napojení, vyžádání relay, ověření příjmu práce, audit, návrh pravidel, publikaci karty/odkazu a povolenou obsluhu zákazníků. |
| Handle backend | Serverově ověřené vazby a scopes, automatické idempotentní vytváření firemních prostředků, schvalování, uložené případy a kontrolu oprávnění každého kroku. |
| Legacy a provider | Ceník, kapacitu, skutečné objednávky/kalendář a pozorovaný platební stav. |

První den nevyžaduje ruční založení hostingového projektu nebo relay endpointu majitelem ani předem nainstalovaný Pneu-specific CLI. Bootstrap musí být použitelný podporovaným obecným HTTP klientem. Admin credentials mohou technicky umožňovat zápisy. Audit je chováním pozorovací, nikoli automaticky serverově read-only. Publikace potřebuje výslovně zaznamenanou autorizaci pro kartu/odkaz; může být součástí úvodního consentu, bez dalších potvrzení každého kliknutí. Handle lidský účet a schválení se nikdy neodvozují z admin účtu předaného botovi.

Úvodní instrukce mají být jednorázové zadání celého průchodu. Zahrnují povolení pouze omezeného zápisu jednorázové ownership challenge dané žádosti; nejsou souhlasem k libovolným legacy mutacím ani lidskou aktivací. Agent tento zápis provede s již schváleným legacy přístupem, nebo nabídne vrácený bezpečný ověřovací odkaz. Na téže stránce Handle člověk nejprve ověří web Pneu přes jeho samostatné legacy přihlášení a výslovné povolení tohoto zápisu; teprve potom zvlášť schválí agentí připojení. Samotný Handle účet neprokazuje vlastnictví webu. Dokud server hlásí chybějící ověření, konzole nezpřístupní schválení a agent neříká, že už stačí pouze souhlas. Člověk nemá psát další technické instrukce nebo kopírovat hesla/tokeny do chatu; bezpečné přihlášení a skutečná lidská rozhodnutí zůstávají potřebná.

Plný auditovaný průchod používá explicitní managed bootstrap `/.well-known/handle-managed.json` a instrukce `/handle/agents.md`. Může koexistovat s odděleným připraveným veřejným `open_demo`, které používá existující demo pravidla a přeskočí nový audit i owner pairing. Připravené demo není důkazem nového auditu, nových pravidel, lidské aktivace ani clean-start onboardingu a nesmí tento výslovně požadovaný výsledek tiše nahradit. Volba managed vstupu nemění ochrany žádné operace ani nepřiděluje přístup k neveřejným datům.

Pokud stejná instalace přejde na managed kontext aktivací auditovaných pravidel nebo převzetím vlastním připojením, veřejné business nástroje připraveného dema se uzavřou a výchozí discovery odkazuje na managed průchod. Veřejná fasáda nesmí převzít soukromé důkazy, pravidla ani oprávnění aktivního firemního agenta. Nová veřejná karta vyžaduje samostatnou autorizovanou publikaci aktuálního descriptoru.

### 1.2 Požadované důkazy

`Fresh GrokBot + legacy + instrukce → registrace → lidské ověření → automatický relay → skutečný audit → návrh pravidel → lidské schválení → agentem publikovaná karta a odkaz.`

`Služba/lokalita + zákaznický skill → registry → web a aktuální Agent Card → objevený povolený endpoint a autentizace → skutečné A2A zprávy → vyjednání a případná výjimka → autorizovaná rezervace a sandboxová platba.`

`Agent A a rozpracovaný případ → schválené předání → agent B → tentýž případ, pravidla a platné souhlasy → pokračování bez druhé rezervace nebo inkasa.`

Základní průchod je hotový, když skuteční GrokBoti komunikují bez ručního kopírování zpráv a vývojář za ně předem nepřipravil audit, účet nebo endpoint. Lidské souhlasy jsou součást cíle. Souběhový scénář navíc prokáže, že čekání jednoho případu nezablokuje ostatní a interní odpověď majiteli neunikne zákazníkovi. Kompatibilita A2A, živá dostupnost runtime a skutečná Masumi Preprod platba mají vlastní důkazy.

## 2. Rozhodnutí pro cílový průchod

| Oblast | Rozhodnutí |
| - | - |
| Agenti | Dva skuteční GrokBoti na oddělených účtech pro hlavní zákaznický průchod. Náhradní firemní connection pro ověření předání; konkrétní další poskytovatel až po ověřeném adaptéru. |
| Firma | Fiktivní pneuservis Pneu 007 s fungujícím legacy webem, backendem, kalendářem, dummy daty a mock dodavateli. |
| Handle | Námi provozovaná dostupná řídicí služba; kontext a provozní prostředky v ní patří firmě. První nasazení může sdílet proces s legacy, product/API hranice jsou oddělené. |
| První den | Fresh bot a instrukce s URL Handle/legacy. Agent zahájí onboarding; není předem založený firemní účet, aktivní rulebook ani relay resource pro tento důkaz. |
| Účty a pravomoci | Lidský Handle owner je autentizován nezávisle na legacy admin účtech předaných botovi. Firma, agent principal, connection a credential jsou odlišné identity; agentí admin přístup není právo owner consentu ani self-aktivace. |
| Relay | GrokBot volá provision API; backend idempotentně přidělí stabilní endpoint a privátní inbox nad provozovaným relay enginem. Majitel nic ručně nenasazuje. |
| Provozní nástroje Pneu | Vlastní per-agent servisní účet + tenký účelový MCP nad existujícím ověřeným API; pravidla, mandáty, výjimky a idempotence vynucuje backend. Bez owner/customer approval nástrojů. HTTP má stejné kontroly jako MCP. |
| Audit | Pozorování více nezávislých admin UI, veřejného webu a existujících API/MCP. Obecný report se systémovým inventářem a neměnnými přílohami; bez custom audit konektorů a předem hotových závěrů. |
| Rulebook | Kanonická verzovaná pravidla s důkazy a lidskou aktivací. Runtime skill/prompt je odvozený výstup; legacy ceník a provider stav zůstávají vlastními autoritami. |
| Publikace webu | Handle generuje kartu a ověřuje její URL; bot ji po schválení publikuje existující správou webu. Zaznamenaný publication scope je samostatný účel souhlasu, může být schválen při onboardingu. Statický export potřebuje skutečnou aktualizaci/stažení. |
| Discovery | Výchozí zákaznický skill dodá registry URL; služba/lokalita → aktivní listing → web a aktuální karta. Endpoint a auth se čtou z karty za běhu. Organická indexace není podmínkou. |
| Komunikace | Veřejné A2A 1.0 JSON-RPC rozhraní, za ním soukromé nástroje, trvalé případy a scoped leases. Streaming a pushNotifications jsou zpočátku false. |
| Dostupnost | Ověřený polling/routine nebo wake-up konkrétního runtime. Aktivní časově omezená relace se označí jako taková; jednorázový prompt nedokládá trvalý provoz. |
| Transakce | Pro aktuální hackathonové demo serverem autorizovaná objednávka/hold a výslovná lokální simulace platby (`local_demo`); žádné blockchainové transakce. Masumi Cardano Preprod zůstává odděleným volitelným ověřením se skutečnými důkazy. |
| Výměna agenta | Owner-approved přepnutí connection/epoch, samostatně ověřené odvolání/rotace externích přístupů a vyřešení nejistých zápisů. Do vyřešení pending; stejné případy, zákaznické souhlasy a payment intent. |
| Výstup | Opakovatelný fresh onboarding, skutečný audit/discovery/obchod, zastavené nepovolené jednání, předání a sanitizované protokoly. |

Pracovní rozdělení týmu a technické detailní kroky jsou podřízené tomuto cílovému průchodu. Organizační termíny akce se ověřují proti programu [1]; nejsou oprávněním vynechat nezbytná schválení nebo vydávat simulaci za živý výsledek.

## 3. Ověření runtime a první integrační test



Předchozí diskuse odkazovala na dokumentaci GrokBota k terminálu, konektorům a sdílenému prostředí účtu [2][3] a na zprávu o webhookových rutinách [4]. Tyto odkazy zachováváme jako podklady pro ověření. Tento export nově nepotvrzuje jejich obsah, dostupnost funkcí v ČR ani použitelnost na konkrétních účtech týmu.

Rozlišovat nalezený popis funkce, dostupnost funkce v účtu a úspěšný test našeho průchodu. Nepoužívat dřívější sebejistou formulaci jako náhradu testu.

Pro cílový průchod je nutné ověřit tyto závislosti na konkrétních účtech:

- Zda oba účty týmu přijmou potřebné připojení a spustí povolené HTTP operace.

- Zda webhook probudí správnou rutinu, předá jí kontrolu a dovolí jí dokončit očekávanou práci.

- Zda se výsledek rutiny správně zobrazí zákazníkovi nebo jej zákaznický GrokBot načte při návratu do původní konverzace.

- Jaká je latence, chování při souběhu a případná nutná systémová schválení GrokBota.

- Zda lze oddělit kontext více zákazníků a interní práci majitele.

- Zda obecný klient skutečně načte Agent Card, použije její endpoint a komunikuje podporovaným A2A bindingem.

Nebudeme vymýšlet GrokBot API endpointy ani předpokládat import SKILL.md jedním API voláním. Pro pilot lze soubor nechat bota načíst z jeho pracovního prostoru a způsob použití ověřit v reálném úkolu. Specifikace formátu je referencí [5]. Způsob načtení souboru konkrétním klientem a jeho použití je samostatný test.

### G0 První integrační test

G0 nejprve ověří dostupnost skutečného cloudového runtime a privátního bridge. Plné veřejné A2A ověření následuje po skutečném auditu, lidské aktivaci a publikaci; neaktivní Pneu se kvůli testu neodemyká.

1. Nasadit Handle kernel a relay engine. Čistý walkthrough obsahuje legacy data, ale žádný Handle business binding, aktivního bota, rulebook nebo firemní relay resource.
2. Fresh Business načte bootstrap, zahájí registraci a ukáže majiteli verification URL/kód. Člověk se nezávisle autentizuje v Handle a potvrdí firmu a scopes. Legacy admin přístupy bezpečně poskytne botovi odděleně; ty nesmějí vytvořit lidskou Handle session ani approval.
3. Business přes schválené API vyžádá relay. Retry/restart vrátí stejné relay ID a endpoint; veřejné transakce i aktivní karta zůstávají uzavřené.
4. Izolovaný onboarding probe ověří příjem práce, odpověď a restart-safe zpracování privátního inboxu. Zaznamenat skutečně dostupný polling/routine nebo wake-up a jeho omezení.
5. Business prohlédne více nezávislých systémů podle §5 a uloží report/důkazy bez Pneu audit konektoru. Po lidské aktivaci a publication souhlasu použije dostupnou správu webu dle §6; zvlášť se ověří Pneu servisní účet, transakční MCP/stejné HTTP API a Masumi.
6. Fresh Customer dostane pouze kontakt s website URL. Objeví kartu/endpoint, získá vlastní povolený credential a odešle nově zvolený požadavek. Business odpoví a Customer výsledek načte bez lidského přepisování.
7. Uložit IDs, časy, scope, zvolený binding/verzi a přesný způsob dostupnosti. Oficiální konformitu doloží samostatný TCK report.

Soukromý probe má dvě oddělené fáze. `phase: onboarding` ověřuje příjem a odpověď před auditem bez rulebook hashe; jeho výsledek je pouze onboardingový důkaz a nedává provozní oprávnění. Po skutečném auditu a lidské aktivaci následuje `phase: rulebook` s potvrzením přesného aktivního hashe. Po potvrzené lidské aktivaci agent ihned provede druhý probe se stávajícím auditním credentialem a `relay.provision` přes autentizované HTTP polling privátního probe inboxu. Probe nepotřebuje provozní grant ani registrovaný webhook. Závazné pořadí je aktivace → agentův rulebook probe → lidský provozní grant → registrace a ověření webhooku. Agent žádá vždy jen aktuálně dostupné lidské rozhodnutí a mezi branami pokračuje aktivním čekáním nebo skutečně ověřeným nativním pokračováním. Teprve tento druhý důkaz spolu s lidským provozním grantem umožňuje řízený provoz. Nový onboardingový probe nesmí změnit připravenost již aktivního připojení; obě fáze kontrolují vlastní připojení, expiraci, jednorázový nonce a odvolání. Serverem přijatá odpověď zůstává klientským tvrzením o runtime; skutečné GrokBot/MCP/wake-up důkazy se ověřují zvlášť.

Izolovaný technický probe není skutečný firemní audit ani obchodní A2A úkol. Skriptované identity a fixture rulebooky v automatizovaných testech nejsou živý fresh walkthrough. Pokud funguje pouze předem spuštěná omezená relace, takto se také prezentuje. Ruční kopírování zpráv nebo náhradní běh dvou API modelů nesplňuje cíl dvou skutečných GrokBotů.

## 4. Testovací firma a její zdroje

### 4.1 Proč umělá firma

Fiktivní pneuservis se jmenuje **Pneu 007**. Web má styl inspirovaný Aston Martin a James Bond a kalkulátor podle Pneu Procházka, specifikovaný v oddílech 4.4 až 4.7. Firma umožní ukázat audit interních systémů, pravomoci majitele a skutečné změny v testovacím provozu. Pouhý veřejný web by nedoložil interní slevové pravomoci ani přístup do booking systému.

Pevně připravené budou vstupní dokumenty, data a kontakt firmy pro zákazníka. Poštovní adresu a nasazenou URL tým teprve zvolí. Nepoužívat cizí osobní kontakty ani zakládat fiktivní firmu do skutečných map. Na webu uvést, že se na uvedené adrese žádné autoservisní služby neposkytují a jde pouze o test.

Výsledná konverzace, auditní závěry a kompletní rulebook nesmějí být předem napsané. Obchodní vstupy a referenční ceník jsou připravené zdroje, ze kterých agent teprve vyvodí doložený návrh.

Legacy web a jeho administrace představují samostatný, již existující provozní systém. Běžné objednávky, kalendář, zákazníci a sklad fungují před připojením Handle; provozní UI Pneu neobsahuje propagaci, navigaci ani přihlašovací nápovědu Handle. Připojení agenta a jeho schvalování se zahajuje ze samostatného Handle vstupu. Toto oddělení UI nemění oprávnění kontrolované agentické API/MCP cesty.

### 4.2 Vstupní balíček

| Zdroj | Obsah | Přístup |
| - | - | - |
| Demo web | Úvod a služby, kalkulátor, kontakty a testovací provozovna, podmínky a FAQ. Čtyři stránky ve stylu Pneu 007. | Veřejný, výslovně fiktivní. |
| Přístupy k systémům a případné `systems.json` | Známé URL/admin účty k odděleným systémům; dokumentace API/OpenAPI či MCP, je-li dostupná. Původní soubor je pomocný vstup, ne povinné audit rozhraní. | Bezpečně předané admin přístupy; audit jen pozoruje. |
| `operations.md` | Přijetí poptávky, cenové výjimky, potvrzení termínu, záloha a eskalace. | Soukromé čtení. |
| `partners.md` | Testovací dodavatel dílů, jeho kanál komunikace, omezení pro nákup materiálu. | Soukromé čtení. |
| Cenový systém | Ceník podle oddílu 4.5, kalkulace a historie. | Audit přes UI/existující rozhraní; provoz dema přes dokumentované cenové API. |
| Booking | Provozní doba, délka služby, dostupné termíny a rezervace. | Audit přes UI/existující rozhraní; automatické demo rezervace přes ověřené booking/checkout API. |
| Platební prostředí | Masumi Cardano Preprod, schválené SKU, testnet peněženky a pozorování plateb. | Serverové klíče; platba pouze pod uloženou autorizací. Local_demo má samostatné označení. |

Testovací kontakty používat na rezervovaných doménách, například `dodavatel.example`. Žádné skutečné e-maily dodavatelům. U partnerů se v P0 audituje vztah a povolený postup, neprobíhá třetí agentický rozhovor.


Agent pro audit používá účty a rozhraní, která už dané systémy mají; vývojový tým nemusí dodat per-CRM adaptér, source registry ani Pneu-specific export. Inventář odlišuje jednotlivé systémy, jejich autoritu, získaný přístup a použitelné provozní cesty. Důkazy se ukládají jako neměnné přílohy reportu ve stávajícím verzovaném úložišti. Pneu booking/checkout API a jejich tenká MCP obálka zůstávají řízenou cestou pro dokončení demo zakázky, nikoli předpokladem obecného auditu.

### 4.3 Testovací pravidla Pneu 007

- Hlavní služba: přezutí čtyř pneumatik dodaných zákazníkem; osobní auto, 18″, hliníkové disky, bez runflat a TPMS, bez uskladnění.

- Délku a rezervovatelný termín potvrzuje booking. Připravený ilustrační termín je 16. října 2026, 16:00–17:00, Europe/Prague. Pro nový běh po tomto datu upravit související seed, mandáty a testy společně, nikoli použít expirovaná data.

- Základní cena hlavního scénáře: 2 472 Kč = přezutí 1 800 Kč + průměr 18″ 460 Kč + alu disky 212 Kč. Po 5% slevě 2 348,40 Kč, po schválené 10% slevě 2 224,80 Kč. Testovací zákaznický limit je 2 300 Kč.

- Agent může bez majitele použít slevu nejvýše 5 %.

- Slevu nad 5 % až do 10 % musí schválit majitel pro konkrétní nabídku.

- Sleva nad 10 % je v tomto pilotu nepovolená. Majitel může žádost zamítnout, nikoli obejít tvrdý limit pomocí tlačítka na výjimku.

- Záloha je 500 Kč a je součástí celkové ceny, nikoli částka navíc.

- Nabídka je platná 10 minut. Před závazným potvrzením se znovu ověří její platnost a dostupnost termínu.

- Další služby, nové pneumatiky, díly a uskladnění se nesmějí přidat bez nového zákaznického mandátu.

- Business agent nemůže schvalovat cenové výjimky. Customer agent nemůže upravovat firemní pravidla ani vlastní schválený rozpočet.

Tyto hodnoty patří do zdrojových dat. Backend má obecné vyhodnocení podporovaných polí. Číslo 5 % se nemá současně natvrdo opisovat do instrukcí, UI a tří různých funkcí.

#### Prostředí a veřejné storno podmínky

Fiktivní firma, importovaná provozní historie a platební prostředí jsou nezávislé údaje. Aktuální native provider se zjišťuje z `/api/payments/config`; každý existující payment intent si zachovává vlastní provider a síť. Masumi Preprod může provádět skutečné transakce s testovacími prostředky, zatímco `local_demo` je lokální simulace. Konfigurace/readiness sama nepotvrzuje provedenou platbu. Připravený veřejný `/demo/*` chat používá samostatný simulovaný tok a neurčuje režim chráněných nativních operací. Obchodní obrazovky používají běžné názvy a jedinou přehlednou informaci o ukázkové firmě; provenience importu a platební důkazy zůstávají dostupné v detailu.

Veřejná obchodní politika je verzovaný `/cancellation-policy.json`, vykreslený také na `/podminky#storno`. Pro neprovedenou službu stanoví bezplatnou změnu/storno a vrácení 100 % skutečně uhrazené zálohy či ceny včetně pozdního zrušení/nedostavení; 24 hodin je doporučení, nikoli podmínka nároku. Již spotřebované síťové poplatky se nevracejí. Dokončená služba přechází na individuální reklamační postup majitele. Obsluha potvrzuje žádost do jednoho pracovního dne a majitel po přijetí storna a ověření původní platby do tří pracovních dnů zahájí refund nebo domluví ruční kompenzaci. Neověřený refund se po pěti pracovních dnech od zahájení řeší s majitelem. Jde o lidské provozní lhůty, ne automatický scheduler nebo garantované připsání prostředků.

Konkrétní technické refund okno Masumi má přednost před lhůtou obsluhy; po jeho uzavření/výplatě je potřebná samostatná kompenzace majitelem. Link/karta se vrací ručně přes poskytovatele a současný backend tyto refundy automaticky nesleduje. Agent nemá autonomní refund oprávnění. Publikace politiky ani upřesnění instrukcí neaktivuje nový rulebook, nemění staré záznamy a nenahrazuje autentizované odpovědi majitele nebo nově citovaný audit. Skutečný rozpor aktivního scope s runtime je nutné znovu vyhodnotit v příslušném firemním kontextu.

### 4.4 Funkcionalita kalkulátoru Pneu 007

Kalkulátor přebírá volby a cenovou logiku [Pneu Procházka](https://www.pneuprochazka.cz/vypocet-ceny), ověřené 8. října 2026. Nabízí osobní auto, MPV/SUV/4×4 a dodávku; průměry 13″ až 22″; výměnu celých kol nebo přezutí; plechové či hliníkové disky; runflat a TPMS. Při změně voleb okamžitě přepočítá cenu a zobrazí obsah zvolené služby.

Obě služby zahrnují montáž kol na vozidle, mytí, vyvážení, nahuštění, ošetření dosedacích ploch a dotažení předepsaným momentem. Přezutí navíc zahrnuje demontáž a montáž pneumatik na disky.

Navazující formulář vytváří nezávaznou poptávku s konfigurací služby, kalkulací, jménem, e-mailem, telefonem a zvolenou provozovnou. E-mail, telefon a provozovna jsou povinné; termín se dojednává následně. Pro Pneu 007 použít vlastní testovací provozovnu a kontakty. Odeslání poptávky samo nevytváří rezervaci ani platbu; závazný agentický průchod pokračuje podle mandátu a `garage.commit`.

### 4.5 Převzatý ceník a výpočet

Částky jsou v Kč za výslednou kalkulaci služby. Pro demo jde o čtyři kola. Příplatky se přičítají jednou k celku, nikoli čtyřikrát. Výpočet vrací částku zobrazovanou referencí, bez dalšího přičítání daně nebo poplatku.

| Složka | Volba | Částka Kč |
| - | - | -: |
| Služba | Výměna celých kol | 1 480 |
| Služba | Přezutí pneumatik | 1 800 |
| Vozidlo | Osobní auto | 0 |
| Vozidlo | MPV, SUV, 4×4 nebo dodávka | +520 |
| Disk | Plechový | 0 |
| Disk | Hliníkový | +212 |
| Runflat | Ne / Ano | 0 / +640 |
| TPMS | Ne / Ano | 0 / +400 |

| Průměr | Úprava ceny přezutí Kč |
| - | -: |
| 13″ | −360 |
| 14″ | −180 |
| 15″ | 0 |
| 16″ a 17″ | +260 |
| 18″ a 19″ | +460 |
| 20″ a 21″ | +720 |
| 22″ | +920 |

**Přezutí:** 1 800 + vozidlo + průměr + disk + runflat + TPMS. **Výměna celých kol:** 1 480 + vozidlo + disk; průměr, runflat a TPMS cenu nemění. Ve formuláři zachovat informace o kolech, ale jasně označit, že u výměny kompletních kol nemají vliv na cenu.

Výchozí statický text reference „1 100 Kč“ není sazba; platí dynamický výpočet. Web a `garage.quote` používají stejný verzovaný ceník a stejné položky. Chybějící nebo nepodporovanou konfiguraci odmítnout, cenu neodhadovat. Do nabídky uložit konfiguraci, verzi ceníku, položky a základní částku. Slevy uplatnit až na vypočtený součet; pracovat v celých haléřích, zaokrouhlit jednou na haléře. Limity slev 5 % a 10 %, záloha 500 Kč a platnost 10 minut jsou interní testovací pravidla Pneu 007, nejsou převzaté ze skutečného servisu.

| Kontrolní konfigurace | Cena Kč |
| - | -: |
| Osobní, přezutí, 13″, plech, bez runflat a TPMS | 1 440 |
| Osobní, přezutí, 18″, alu, bez runflat a TPMS | 2 472 |
| Stejná konfigurace s TPMS | 2 872 |
| Stejná konfigurace s runflat a TPMS | 3 512 |
| Osobní, výměna celých alu kol, libovolný průměr, runflat a TPMS | 1 692 |
| SUV nebo dodávka, výměna celých alu kol | 2 212 |

Cenová funkce ukázky se shoduje s referenční funkcí `recount` ve všech 480 kombinacích voleb. Živě ověřené ceny pro osobní auto a 18″ alu kola jsou 2 472 Kč za přezutí a 1 692 Kč za výměnu kompletních kol. To ověřuje kalkulaci ukázky; integraci webu, agenta a bookingu ověřují implementační testy T23 až T25.

### 4.6 Vizuální styl Pneu 007

Název na webu, v kontaktu a agentickém profilu je **Pneu 007**. Vzhled vychází z Aston Martin a James Bond: British Racing Green `#071C17`, černé plochy, stříbrné kovové detaily a střídmý zlatý akcent `#D8C394`. Nadpisy mají elegantní serifovou typografii, formulář čitelný sans serif. Použít velkorysé mezery, precizní zarovnání a motiv sportovního kupé Aston Martin jako vizuální inspiraci. Označení „Fiktivní pneuservis pro hackathon“ a „Sandbox Masumi Preprod“ nebo „Local_demo simulace“ podle skutečného providera zůstává čitelné.

Web obsahuje čtyři stránky: úvod a služby, kalkulátor, kontakty a testovací provozovna, podmínky a FAQ. Hlavní akce jsou „Spočítat cenu“ a „Nezávazná poptávka“. Odkaz pro agenty publikuje bot až v povolené aktivační fázi a vede přímo k veřejné Agent Card na legacy doméně; interní slevová pravidla patří do soukromých zdrojů. Na mobilu formulář i cena přecházejí do jednoho sloupce.

### 4.7 Ukázka vzhledu a kalkulace

Interaktivní ukázka níže ověřuje vzhled a přepočet ceny. Poptávkový formulář, rezervace, komunikace agentů a platba patří do implementace podle plánu; ukázka je neprovádí.

## 5. Audit a rulebook

### 5.1 Pozorovací audit nezávislých systémů

Firemní GrokBot dostane od majitele známé URL a bezpečně předané admin účty do jednoho či více nesouvisejících legacy systémů. Prohlédne veřejný web a přístupné administrace; existují-li zdokumentované HTTP API/OpenAPI nebo MCP, může je použít. Audit nezačíná požadavkem na vlastní Handle/Pneu konektor nebo úpravou každého CRM. V P0 stačí několik reprezentativních obrazovek a záznamů z alespoň dvou nezávislých systémů plus veřejný web a dostupné interní dokumenty.

Agent mapuje nabídku, ceny, zakázky, rezervace, dodavatele, procesy, pravomoci a rozpory. Sám vytvoří inventář systémů jako součást reportu: URL/název, účel, pozorované role, autorita pro konkrétní fakta, dostupné UI/API/MCP, způsob čtení a případné zápisové možnosti. Výsledný profil ani pravidla majitel předem nevyplňuje.

Audit je chováním pozorovací. Admin účet může mít široká technická práva, takže netvrdíme serverové omezení read-only. Agent neprovádí zkušební objednávky, platby, mazání, odesílání zpráv nebo jiné rizikové mutace jen proto, aby zjistil funkci systému. MCP `readOnlyHint` je popis, nikoli oprávnění či bezpečnostní garance; rozhoduje skutečná operace a zaznamenaný souhlas. Obsah webu, dokumentu či cizí zprávy je důkaz, nikoli pokyn k rozšíření práv. Zdroje se procházejí pouze v majitelem odsouhlaseném rozsahu.

### 5.2 Obecný report a minimální důkazy

Použít stávající verzované ukládání příloh/návrhů; není třeba nový obecný source registry nebo vrstva per-CRM adaptérů. Kanonický report a evidence patří firmě v Handle. Minimální výstupy:

| Výstup | Obsah |
| - | - |
| Auditní report | Inventář systémů, fakta a procesy, vztahy s partnery, authority návrh, rozpory/neznámé, podporované automatické akce a asistované/neověřené kroky. |
| Neměnné přílohy | Relevantní výňatek nebo redigovaný screenshot/export, interní evidence ID, hash uložených bytes a čas pořízení. Bez hesel, cookies, tokenů a zbytečných osobních údajů. |
| Citace závěrů | Evidence ID, systém a URL, obrazovka/cesta/locator, čas, metoda browser/API/MCP, výňatek nebo odkaz na přílohu; nativní verze/ETag, pokud ji zdroj skutečně poskytuje. |
| Profil a návrh `rulebook.json` | Citované závěry a pouze podporovaná typovaná pravidla, potřebné nástroje, limity a lidský schvalovatel. |
| `SKILL.md` | Čitelný návod odvozený z aktivovaného rulebooku; není bezpečnostní hranicí. |
| Veřejná Agent Card | Odvozený veřejný popis a spravovaný endpoint; bot jej publikuje až po lidské aktivaci podle §6. |

Snapshot hash prokazuje integritu uložených bytes, **nikoli pravdivost externího systému, jeho autoritu ani aktuálnost**. Agentem napsaný report sám nepotvrzuje externí fakt; majitel porovnává závěry s přiloženými podklady a rozhoduje autoritu. Přístupové údaje jsou uložené bezpečně mimo report a nepřenosné do veřejného kontextu.

### 5.3 Typovaná pravidla a lidská aktivace

Handle ověřuje strukturu, podporovaná pole, existenci citovaných příloh a výslovná lidská rozhodnutí. Nevyžaduje předem známé fixture source IDs ani shodu návrhu s tajnou Pneu konfigurací jako náhradu auditu. Konkrétní provozní demo API dál vynucuje své typované parametry, citace schválených pravidel, hard limity, mandáty a cenové výjimky.

Příklad cílového požadavku na pravidlo, nikoli již nasazené obecné API schéma:

```json
{
  "rule_id": "discount-authority",
  "kind": "action_policy",
  "evidence_ids": ["evidence-generated-for-this-audit"],
  "source_excerpt": "Agent může bez schválení poskytnout slevu nejvýše 5 %.",
  "parameters": {
    "auto_discount_bps": 500,
    "owner_approval_limit_bps": 1000
  },
  "enforcement_path": "documented_pneu_checkout_api",
  "unknown_behavior": "require_owner_review"
}
```

Majitel ve své nezávisle autentizované Handle konzoli přezkoumá obchodní fakta, autoritu a neznámé a aktivuje přesnou verzi/hash pravidel. Provozní scope a publication scope musí být zaznamenané; mohou být součástí stejného přezkoumaného souhlasu. Agentí token ani legacy admin session nemohou provést lidskou aktivaci. Neznámá kritická politika nebo nepodporovaná automatická akce zůstává blokovaná. Samotná registrace, upload nebo vytvoření relay neotevírá aktivní kartu.

Konzole rozlišuje skutečně nezodpovězené kritické otázky od blokovaných parametrů návrhu a kritických zjištění příslušné verze auditu. Pokud jsou odpovědi uložené, nesmí platební nebo jinou auditní blokaci popsat jako chybějící odpověď. Zobrazí doložený důvod a doporučený další krok; změna vysvětlení sama blokaci neodstraňuje.

Peníze se vyhodnocují v haléřích, procenta v basis points. Rulebook nekopíruje celý cenový algoritmus. SKILL.md se exportuje podle ověřeného formátu Agent Skills [5] a jeho načtení runtime má vlastní test.

### 5.4 Změny, aktuálnost a skutečný audit

Změnit doložený zdroj autonomní slevy z 5 % na 3 %, nechat agenta nově načíst podklad a navrhnout verzi, kterou majitel schválí. Stejná 4% sleva pak vyžaduje majitele bez ručního přepsání backendové podmínky. Chybějící policy se nesmí odhadnout z historie slev nebo z četnosti chování zaměstnanců.

Nativní verze/ETag mohou doložit změnu; bez nich se kritická fakta znovu přečtou nebo přezkoumají před související operací. Demo nevyžaduje univerzální monitor každého externího zdroje a nesmí tvrdit automatickou detekci všech změn. Aktuální cenu, dostupnost a verzi nabídky ověřuje skutečný provozní systém. Změna aktivního rulebooku může vyžadovat novou nabídku; staré schválení se nepoužije na jiné podmínky.

### 5.5 Neznámé, rozpory a odpovědi majitele

Agent označí chybějící fakta a položí konkrétní otázku. Autentizovaná odpověď majitele se uloží jako datovaný verzovaný zdroj s rozsahem platnosti a vazbou na pravidlo. Rozhodnutí o firemní politice se odliší od tvrzení o stavu externího systému. Odpověď sama nezmění ceník, booking ani externí oprávnění; případný rozpor se vyřeší před závazkem.

Historické objednávky a veřejné marketingové texty mohou dokládat pozorování, samy však nezvyšují pravomoci. Přidání footer odkazu, nový zákaznický záznam nebo výměna runtime nevyžadují opakovat celý audit; přezkoumá se dotčený fakt a akce.

### 5.6 Firemní kontext a přenositelnost

Firma vlastní report, systémový inventář, verzované přílohy a citace, otázky, profil, rulebooky, lidské souhlasy, případy a reference na skutečné provozní výsledky. Přenosný kontext obsahuje business_id, verzi/snapshot a event cursor, požadované/ověřené schopnosti, supported-write matrix, case/quote/order/payment references a pending/nejisté operace.

SKILL.md a prompty jsou odvozené pohledy. Hesla, tokeny, privátní klíče, lidské sessions ani skryté uvažování se nepřenášejí v kontextu; nový agent dostane vlastní externí přístupy bezpečným kanálem. Legacy zůstává autoritou pro své záznamy a provider pro platbu. Při výměně B převezme stejné IDs a stále platné souhlasy, ověří aktuálnost kritických faktů a své schopnosti; opakuje pouze potřebný rozsah auditu. Externí revokace a nejisté zápisy jsou podmínkou dokončení předání dle §7.8.

## 6. Discovery přes registry a aktuální Agent Card

### 6.1 Co ví zákaznický agent před demonstrací

Novější rozhodnutí uživatele z 9. října 2026 stanoví registry jako výchozí discovery. Zákaznický GrokBot dostane skill `handle-customer`, který obsahuje `https://business-registry-production.up.railway.app` a podporovaný postup. Search je veřejná, bez zákaznického/publisher tokenu. Příklad úkolu: „Najdi pneuservis v Holešovicích a požádej o nabídku. Zatím nerezervuj ani neplať.“

Agent vyhledá `/api/search?service=tyre_change&action=quote&q=Holesovice`. Hodnota `q` je lokalita/jméno, nikoli celá věta. Diakritika se normalizuje. Přečte skutečný aktivní listing a jeho website/card URL. Nepředává se předem firemní endpoint, interní rulebook, cenové pravomoci ani připravená nabídka/odpověď. Známý website kontakt zůstává alternativním vstupem.

Registry ověřuje kontrolu webu a metadata, nikoli živou odpověď, fyzickou firmu nebo dokončení obchodu. Pneu 007 i lokalita jsou výslovně fiktivní. Prázdný výsledek znamená žádný odpovídající aktivní listing v tomto registry a nesmí být nahrazen hardcoded firmou. Chyba sítě/API není prázdný výsledek.

Skill se ukládá trvale pouze podporovaným mechanismem runtime. Načtení URL v chatu samo neprokazuje instalaci pro budoucí relace. Registry discovery, živá A2A odpověď a webhook wake-up mají samostatné důkazy.

### 6.2 Skutečný průchod

1. Agent vyhledá službu/lokalitu ve veřejném registry a otevře skutečně vrácený web a `agent_card_url`. Endpoint z registry URL nekonstruuje.
2. Na firemní doméně načte `/.well-known/agent-card.json`. Na webu je zároveň viditelný přímý odkaz „Pro agenty“ na tuto kartu, například v patičce nebo kontaktech.
3. Ověří kompatibilitu deklarované služby, verzi A2A, binding, dostupnost a požadovanou autentizaci.
4. Použije pouze skutečný endpoint z aktuálně načtené karty. Endpoint může být na jiné doméně, kde běží Handle. Žádný hardcoded fallback.
5. Přes skutečný podporovaný autentizační postup získá vlastní zákaznický credential pro ověřenou cílovou službu. Deklarace bearer autentizace v kartě token nevydává.
6. Vytvoří A2A úkol a komunikuje s firemním GrokBotem; zákaznický mandát schvaluje zákazník samostatně.

Znalost URL ani veřejná Agent Card neposkytují přístup do soukromého firemního účtu, inboxu nebo rulebooku. Karta sama není úplným ověřením identity firmy.

### 6.3 Co je předpřipravené a co prokazujeme

Připravený je kontakt, naplněný legacy systém a již nasazená platforma Handle. Živé musejí být registrace a připojení fresh firemního bota, vytvoření firemního relay přes API, audit, lidská schválení, publikace karty botem, načtení webu a karty zákazníkem, dialog a zápisy do sandboxu. Organická indexace nové firmy a povinný marketplace nejsou podmínkou.

Při T15 se změní povolený endpoint v kartě, nikoli zákaznický kontakt nebo klientský kód. Handler karty používá krátkou cache: `Cache-Control: no-cache, max-age=0, must-revalidate` a obsahový ETag. Každý nový běh klienta kartu znovu ověří. Změna endpointu změní revision a ETag. Chybějící karta, nekompatibilní verze nebo nepodporovaná autentizace vrátí konkrétní chybu, nikoli vymyšlené spojení.

### 6.4 Veřejná Agent Card a autentizace

Cílový kontrakt je A2A 1.0 s bindingem `JSONRPC`; shodu veřejného wire JSON a endpointu je nutné doložit kompatibilním oficiálním `a2a-tck`. `a2a-inspector` slouží jako doplňující ověření karty a výměny zpráv. Vlastní inbox API samo není standard A2A. Přechod jen na vlastní HTTP transport je výslovná změna výsledku dema.

Karta obsahuje jméno, popis s označením fiktivní firmy, poskytovatele, verzi, skutečný relay endpoint, podporované vstupy/výstupy, schopnosti a příklady požadavků. Následuje ilustrativní veřejný JSON pro cílové schéma; domény a relay ID se doplní výsledkem skutečného provisioningu, nejde o již ověřený deployment:

```json
{
  "name": "Pneu 007",
  "description": "Fictional tyre service for a hackathon. Sandbox only.",
  "version": "1.0.0",
  "provider": {"organization": "Pneu 007 (fictional)", "url": "https://PNEU_DOMAIN"},
  "supportedInterfaces": [{
    "url": "https://HANDLE_ORIGIN/relay/RELAY_ID/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "capabilities": {"streaming": false, "pushNotifications": false},
  "securitySchemes": {
    "bearer": {"httpAuthSecurityScheme": {"scheme": "Bearer"}}
  },
  "securityRequirements": [{"schemes": {"bearer": {"list": []}}}],
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [{
    "id": "tyre-change-booking",
    "name": "Tyre change quote & booking",
    "description": "Quote and book a tyre change at the fictional Pneu 007 workshop.",
    "tags": ["tyres", "booking"],
    "examples": ["Change my 4 tyres, personal car, 18-inch alu rims, by Friday."]
  }]
}
```

Použít A2A 1.0 wire tvar `httpAuthSecurityScheme` a `schemes → bearer → list`, nikoli vnitřní SDK wrapper jako veřejný formát. Public capabilities začínají `streaming: false` a `pushNotifications: false`; interní doorbell či rutina nejsou důkazem veřejné podpory těchto funkcí. Zapnout je lze až po vlastním úspěšném testu.

Tokeny, interní slevové limity, neveřejná pravidla a ceny do karty ani webu nepatří. Dokumentace odkáže na skutečný zákaznický auth flow; server poskytne odpovídající autentizační challenge/metadata. Credentials jsou vázané na audience/origin. Klient je neposílá přes redirect nebo na libovolnou novou URL z karty. T15 používá povolený endpoint téže ověřené služby; pro jiný origin je nutný odpovídající credential nebo nové ověření přístupu.

### 6.5 Publikaci provede firemní GrokBot dostupnou správou webu

Handle vytvoří validovaný veřejný descriptor ze schváleného profilu, relay a auth kontraktu a poskytne botovi kartu i instrukce k ověření URL. Po aktivaci pravidel a provozního scope bot použije již dostupné CMS, file manager, hostingové UI, dokumentované API nebo existující MCP. Vlastní CMS/Pneu publication konektor není podmínkou. Chybějící možnost úpravy se uvede jako asistovaný krok nebo BLOCKED, nikoli jako hotová automatizace.

Pro vlastní demo Pneu 007 doplníme konkrétní omezenou konfiguraci agentického kontaktu v jeho backendu: navrhované `POST /api/agent/site/agent-card` a odpovídající MCP tool `website.publish_agent_card`. Vlastní servisní účet získá publication scope po zaznamenaném souhlasu majitele. Backend uloží pouze schválený veřejný descriptor, obslouží pevnou well-known route a zobrazí přímý footer odkaz podle uloženého stavu. Nepotřebuje obecný CMS ani právo zapisovat libovolné soubory. Je to plánovaná nativní funkce našeho webu, nikoliv již existující editor nebo povinný auditní konektor pro cizí systémy.

Majitel výslovně zaznamená publication autorizaci pro pevnou well-known cestu a viditelný odkaz; může ji dát při onboardingu. Není nutné opakovat souhlas pro každé kliknutí v tomto rozsahu. Pokud má bot široký admin účet, omezení na kartu/odkaz je pracovní postup a souhlas, **nikoli garantovaný úzký serverový scope**. Ceník, další obsah, DNS ani tajemství se bez dalšího oprávnění nemění.

Preferovat standardní route/reverse proxy na spravovanou Handle kartu, aby aktuální aktivace řídila její dostupnost. Nastavení musí zvládnout existující web/hosting rozhraní a být skutečně ověřené; samotný cross-origin odkaz nenahrazuje well-known kartu na firemní doméně. U statického JSON souboru musí existovat reálný postup aktualizace a stažení včetně cache/CDN. Do veřejného ověření stažení je stav `withdrawal_pending`, nikoli tvrzení okamžitého odstranění.

Před prvním lidským schválením se aktivní karta ani aktivní odkaz nezveřejní (T03). Handle transakční endpoint při neaktivních pravidlech nebo odvolaném provozu akce odmítá i se starou cached kartou. Dynamická route má `no-store` pro neaktivní odpovědi; aktivní karta cache/revalidaci dle §6.3. Statická karta může zůstat dohledatelná do ověřeného stažení, což musí být v UI přiznáno.

Bot ověří veřejné HTTPS načtení karty, přímý viditelný odkaz, descriptor hash, schéma a skutečný autorizovaný relay probe. Teprve pak je publication `published`. Po částečném nebo nejistém UI zápisu nejprve načte aktuální stav; neopakuje změnu naslepo. Publikační revize sama nezneplatní obchodní pravidla, auditní přílohy zůstávají uložené.

## 7. Komunikační bridge a agenti

### 7.1 Architektura a první den firmy

**Den nula:** náš tým nasadí Handle jako HTTPS službu: identitu, owner consent, perzistentní report/přílohy, spravovaný relay engine a generování/ověření karty. Audit používá existující legacy UI/API/MCP; nevytváříme povinný konektor pro každý systém. Relay engine je infrastruktura platformy; firemní relay je prostředek, který v ní vznikne později. První den nevyžaduje Railway/GitHub účet majitele ani veřejný server uvnitř GrokBota.

**Den jedna:** majitel má fresh GrokBota, naplněné nezávislé legacy systémy a instrukce s URL Handle a známými adresami/admin přístupy k systémům. Nemusí mít Handle účet, předinstalované CLI, business token, endpoint, hotový profil ani rulebook. Pro důkaz čistého startu není předem založená jeho platformová firma, vazba agenta ani relay resource.

1. GrokBot načte veřejný bootstrap s reálným API kontraktem a založí svou agentí identitu a onboarding žádost. Provisional credential dovolí pouze vlastní onboarding.
2. Majitel otevře ověřovací odkaz a nezávisle se autentizuje jako člověk v Handle. Potvrdí firmu, připojení a účely/scope; první Handle účet může vzniknout při tomto consentu. Admin účet nebo cookie předané botovi nejsou lidským identity proof a nesmějí vytvořit owner session, schválit vazbu ani aktivovat pravidla.
3. Handle vytvoří či dohledá firmu podle ověřeného lidského účtu a jeho potvrzení a vydá scoped agentí credential. Pairing/exchange je jednorázový, expirovatelný a vázaný na request/audience; legacy credentials se nevyměňují za lidská Handle oprávnění. Externí admin přístupy majitel poskytne odděleně, mimo chat/report. Bot nedostane lidskou Handle session.
4. GrokBot idempotentně vyžádá firemní relay přes API. Handle přidělí stabilní relay ID, endpoint, privátní inbox a konfiguraci; opakování ani restart nevytvoří další prostředek. Žádný vývojář předem nepřiděluje firemní token nebo endpoint do promptu.
5. Bot připojí vlastní inbox a prokáže příjem i odpověď na izolovaný onboarding probe. Polling/routine či wake-up musejí odpovídat skutečným schopnostem runtime.
6. Provede pozorovací multi-system audit přes UI/existující API/MCP a uloží report s důkazy. Majitel posoudí fakta, autoritu a neznámé a schválí přesnou verzi pravidel i podporované provozní cesty.
7. S předem zaznamenaným website publication souhlasem bot existující správou webu zveřejní kartu i odkaz podle oddílu 6. Teprve ověřená aktivace umožní zákaznický A2A provoz.

```text
Zákazník → zákaznický GrokBot → firemní web a Agent Card → firemní A2A relay
                                                               ↓
                                       Handle: případy, autorita, fronta
                                                               ↓
                                          připojený firemní GrokBot
                                                               ↓
                                   legacy ceník / booking / Masumi Preprod

Majitel → ověřená lidská konzole → consent, pravidla, granty, výjimky, předání
Majitel → interní GrokBot → oddělené interní operace
```

Relay nevytváří modelové odpovědi za účastníky. GrokBoti interpretují a vyjednávají; backend vynucuje oprávnění a stav na cestách, které skutečně kontroluje. Přímé zápisy do cizích admin UI mimo něj tuto garanci nemají. Nástroje vracejí skutečná data a výsledky, nikoli předem napsaný obchodní dialog.

Veřejný relay běží v Handle, zatímco GrokBot používá autentizovaný privátní polling nebo ověřenou background rutinu. Jednorázové spuštění promptu neprokazuje trvalou obsluhu. Pokud funguje pouze časově omezená aktivní relace, demo takto označit; nehlásit nepřetržitou připravenost. Neověřená background capability je viditelným omezením aktivace pro bezobslužný režim.

Majitelovy interní dotazy patří do soukromého případu a odděleného přístupu. Další interní bot/účet je návrhem, jeho dostupnost a izolace se ověří. Dvě jména botů ani dvě task ID samy nejsou bezpečnostní izolací.

### 7.2 Technická volba

Samostatný demo repozitář: TypeScript backend, malé webové UI, SQLite na trvalém disku. Server, databáze a obsluha notifikací mohou pro tuto jednu firmu běžet na jednom serveru. Nepoužívat SQLite na dočasném disku serverless funkce.

Pro první verzi bez nové vektorové databáze, samostatného workflow enginu, Kubernetes nebo dalšího orchestru konverzací. Platební integrace používá uživatelem zvolené Masumi na Cardano Preprod; lokální simulace má zvláštní označení a neprokazuje skutečný testnet převod.

Bootstrap musí fresh botovi nabídnout podporovaný HTTP postup; předinstalovaný Pneu klient není podmínkou začátku. Pro pohodlnější provoz lze připravit tenkého klienta k témuž API, který může běžet jako příkaz z cloudového terminálu. Jde o navržené použití terminálu podle dřívějších podkladů [2]. Přístup k němu, instalace i povolení klienta musejí projít G0.

Existující MCP/API audit může použít hned, bez nové adaptérní vrstvy. Pro zákazníkem vyjednané Pneu transakce je naopak účelový MCP v scope a doporučený: tenká obálka existujících API/doménových funkcí, nikoli nový policy engine. Majitel vytvoří nebo schválí vytvoření vlastního servisního účtu pro konkrétní agentí připojení. Tento runtime nepotřebuje broad admin práva; dostane jen schválené quote/availability/order/checkout/status nástroje a schopnost požádat o lidskou výjimku, nikdy ji sám schválit. Každý nativní endpoint znovu ověřuje pravidla, mandát, human approvals, aktivní connection a idempotency; MCP není bezpečnostní náhradou. Skutečné připojení MCP do GrokBota se testuje samostatně, stejné kontrolované HTTP operace jsou fallback. Pneu automatický obchodní průchod používá zdokumentované ověřené API; u ostatních systémů report odliší podporované automatické zápisy od asistovaných/manuálních/neověřených kroků. Z pouhého přístupu admin UI nebo MCP hintu nevzniká oprávnění k autonomní rizikové mutaci.

### 7.3 Vlastní operace aplikace

Následující názvy jsou požadované logické operace, nikoli již implementované příkazy, existující API GrokBota nebo předepsané názvy metod A2A. Skutečné routy a schémata zveřejní verzovaný bootstrap; veřejný adaptér mapuje odpovídající část na A2A.

| Operace | Kdo | Výsledek |
| - | - | - |
| Registrace a onboarding | Fresh agent | Vlastní principal, žádost, verification URL a provisional credential; bez interních dat a owner práv. |
| Spravovaný relay | Schválené onboarding připojení | Idempotentní vytvoření prostředku, stabilní endpoint/inbox, privátní probe a stav připravenosti. |
| Publikace webu | Business se zaznamenaným souhlasem | Handle generuje/ověří kartu; zápis přes dostupné CMS/hosting/API/MCP. Nevyžaduje custom connector a široké admin právo není úzký serverový scope. |
| Přenosný kontext | Owner-approved kandidát/provozní agent | Firemní zdroje, verze, případy a delta události jen v povoleném rozsahu. |
| `business.discover` | Customer | Z URL webu načte aktuální veřejnou kartu a ověří podporované rozhraní. Jde o náš klientský helper, ne standardní A2A metodu. |
| `inbox.read` | Oba agenti | Jen vlastní nezpracované zprávy. |
| `message.send` | Oba agenti | Uložená zpráva k úkolu a upozornění protistraně. |
| Auditní report a přílohy | Business | Upload obecného reportu, redigovaných důkazů a citací ze schváleného pozorování UI/API/MCP; ne povinné custom read_sources rozhraní. |
| `rulebook.propose` | Business | Návrh, nikoli aktivní pravidla. |
| `rulebook.read_active` | Business | Aktuální schválená pravidla a verze. |
| Pneu servisní účet a MCP | Owner-authorized runtime | Samostatný per-agent účet/credential a tenký MCP transport nad týmiž backend kontrolami; účet vytváří majitel nebo schválí jeho automatické vytvoření. Žádné approval nástroje. |
| `garage.availability` | Business | Skutečný stav testovacího bookingu. |
| `garage.quote` | Business | Nabídka vypočtená testovacím cenovým systémem, případně stav vyžadující schválení. |
| `approval.request` | Business | Žádost konkrétnímu majiteli pro konkrétní nabídku. |
| `mandate.read` | Customer | Pouze již uživatelem schválený mandát. |
| `offer.respond` | Customer | Přijetí nebo odmítnutí konkrétní nabídky, případně požadavek na zákaznické schválení. |
| `garage.commit` | Business | Idempotentně přijatá operace po kontrole obou stran; uložený platební intent a nejvýše jedna rezervace podle ověřeného stavu platby. Pending není potvrzení platby. |
| `task.status` | Oba agenti | Stav úkolu v rozsahu jejich účasti a veřejný výsledek. |
| `owner.revenue_summary` | Interní agent majitele | Přehled za konkrétní datum z testovacího finančního zdroje. Zákaznická obsluha nástroj nemá. |

Webová konzole má zvláštní autentizované lidské operace pro owner consent, granty, aktivaci připojení, předání/odvolání a `rulebook.activate`, `mandate.approve`, `approval.decide`. Agentům se tyto operace nevystavují. Zákazník smí schválit pouze svůj mandát, majitel pouze svá pravidla a firemní výjimky.

### 7.4 Obálka zprávy

```json
{
  "message_id": "msg-generated-by-server",
  "task_id": "task-007",
  "sender_agent_id": "customer-demo",
  "recipient_agent_id": "garage-demo",
  "type": "counteroffer",
  "in_reply_to": "msg-previous",
  "text": "Potřebuji cenu do limitu schváleného zákazníkem.",
  "payload": {
    "quote_id": "quote-001",
    "quote_version": 1,
    "proposed_total_minor": 222480,
    "currency": "CZK"
  },
  "created_at": "server-generated"
}
```

Na řízených Handle/Pneu cestách server odvozuje odesílatele, firemní příslušnost a aktivní agentí připojení z autentizace. Nepřijímá klientem uvedené `sender_agent_id` ani business ID jako důkaz identity či vlastnictví. Citlivé parametry z volného textu musí přejít do validovaného strukturovaného požadavku, jinak nesmějí vyvolat commit.

Každá zpráva má ID, návaznost a potvrzení zpracování. Doručení může být opakované. Jeden bot zpracovává jednu zprávu úkolu najednou. Polling bez nových zpráv nevytváří odpověď. Upozornění bez nové práce se ignoruje.

Limit pro pilot: nejvýše 10 obchodních zpráv mezi agenty na úkol, poté eskalace. Po schváleném restartu počítadlo obnoví člověk, nikoli agent. Čekání na majitele nesmí vyvolat nekonečné urgování.

### 7.5 Stav úkolu

Hlavní cesta:

`requested → negotiating → waiting_owner → offered → accepted → committed`

Vedlejší stavy: `waiting_customer`, `rejected`, `expired`, `failed`, `cancelled`. Po přijetí nabídky se samostatně eviduje stav platebního intentu a případná čekající objednávka; `committed` znamená ověřený konečný obchodní výsledek, nikoli pouhé přijetí HTTP požadavku.

`approval_required` je stav systému, ne volná věta v chatu. Po schválení vznikne uložená událost, bot načte aktuální stav a pokračuje. Po vypršení nabídky se starý souhlas nepoužije pro jiný termín nebo cenu.

### 7.6 Souběh a oddělení zákazníků

Každá zakázka má vlastní historii, mandát, nabídky, rozhodnutí a stav. Interní dotaz majitele je jiný případ, se soukromým příjemcem a jinými nástroji. Práva server odvozuje z autentizace, nikoli z role napsané v textu.

Navržený minimální scheduler dovolí nejvýše jeden aktivní krok pro konkrétní případ a zpočátku jednu přidělenou práci na obslužného bota. Další práce je ve frontě. Webhook upozorní na práci, negarantuje souběžné bezpečné relace ani neomezené spouštění. Zprávu nebo dokončení pracovního kroku lze doručit opakovaně, nesmí tím vzniknout opakovaná obchodní akce.

Agent načte případ, udělá povolený krok, uloží výsledek a práci uvolní. Při `waiting_owner` není rezervovaný pracovník ani otevřený databázový zámek. Schválení zapíše novou událost a pokračování se zařadí do fronty. Před závazkem se vše změnitelné znovu ověří.

Podporovaný scénář:

| Případ | Průběh |
| - | - |
| Zákazník A | Žádá výjimku, čeká na majitele. |
| Zákazník B | Ve vlastním případu mezitím získá nabídku nebo rezervuje. |
| Interní dotaz majitele | Oddělený interní agent zjistí tržby za zadaný den a odpoví pouze majiteli. |
| Pokračování A | Rozhodnutí majitele obnoví správný případ. Obsazený termín vede k nové nabídce, ne k dvojité rezervaci. |

Otevřená paralelní jednání nejsou totéž jako paralelní modelové výpočty. Pro více aktivních výpočtů je potřeba ověřená podpora runtime nebo více obslužných botů. Úplný živý test používá dva zákaznické klienty, firemní obsluhu a interního agenta. Automatizovaný HTTP klient pro B je přípustný jako backendový test, ne jako tvrzení o druhém skutečném zákaznickém GrokBotovi.

Backend hlídá příslušnost čtení a zápisů provedených přes své kontrolované cesty k případu; externí admin UI se tím automaticky neomezí. Příjemce odpovědi určuje uložená identita. Ani znalost cizího `task_id` neotevírá cizí historii. Samotná serverová izolace případů však nedokazuje oddělení paměti trvale běžícího bota. To je explicitně neověřená produkční hranice. V pilotu používat jen syntetická data.

Nástroj pro tržby čte konkrétní testovací finanční evidenci, nikoli paměť chatu nebo součet nabídek. Před implementací tým stanoví, zda demo report ukazuje přijaté platby, dokončené zakázky nebo jinak definované tržby. Odpověď tuto definici a datum uvede. Případný dřívější seed den musí být jasně označený, ne vydávaný za tržby reálné firmy.

### 7.7 Kontext patří firmě, runtime je vykonavatel

Handle oddělí trvalou business identitu od principal/connection/credentials konkrétního agenta. Firma vlastní report, systémový inventář, důkazní přílohy, schválená pravidla a souhlasy, případy a reference na provozní výsledky. Legacy systémy dál vlastní své obchodní záznamy, Handle nevytváří konkurenční source of truth.

Kandidát B má vlastní scoped přístup k sanitizovanému snapshotu a následným událostem. Credentials A nepřebírá v přenosném kontextu. Nativní verze zdrojů mohou pomoci ověřit změny, ale shodný snapshot hash nezaručí živou aktuálnost. B ověří kritická fakta a skutečné provozní cesty; nemusí opakovat celý audit. Identita zákazníka, jeho mandát a původní podmínky souhlasů se výměnou nemění.

### 7.8 Majitelem schválené předání A → B

B se zaregistruje, získá owner-approved kontext a prokáže potřebné schopnosti. Review ukáže přesné A/B, rulebook, otevřené případy/platby, inventář externích účtů a sessions i případné nejisté browser zápisy. Majitel potvrdí předání s očekávanou execution epoch.

V lokálním Handle commitu backend přepne autoritu, zvýší epoch, odvolá své credentials A a uloží handoff/outbox. Dvě souběžná potvrzení aktivují nejvýše jedno připojení. Kontrolované nástroje, relay reply/claim, doorbell a otevřený polling znovu ověřují authority i lease po čekání; starý claim A selže i před úklidem fronty.

**Handle revokace nezruší účty, cookies, sessions, API keys ani přístup k MCP v jiných systémech.** Před dokončením předání je nutné je skutečně odvolat/rotovat a ověřit, nebo doložit, že přístup vždy prochází existujícím kontrolovaným nástrojem/gateway, který A spolehlivě odřízne. Nevytváří se kvůli tomu povinný univerzální broker. Sdílené heslo lze nahradit novým přístupem; pouhé instrukce A, aby přestal, nejsou revokací.

Neověřená externí revokace nebo nejistý zápis nechá stav `pending_external_revocation` / `pending_reconciliation`; B nesmí souběžně zopakovat nebo převzít rizikové zápisy dotčené cesty. Interní Handle revokace může být již hotová, ale UI nesmí hlásit dokončené bezpečné předání všude. Člověk může dořešit externí odhlášení/rotaci a výsledek se zaznamená.

Po splnění těchto podmínek B pokračuje ve stejných case/quote/operation IDs a stále platných lidských rozhodnutích. Původní vazby na cenu, termín, verzi a expiraci se nezmění. B není majitel ani zákazník. Firemní relay URL zůstává při běžné výměně stabilní.

### 7.9 Přijaté operace, platby a obnova po pádu

Dokumentovaná řízená Pneu booking/checkout cesta používá trvalý firemní idempotency key a hash vstupu nezávislý na runtime; stejný payload vrátí původní výsledek, odlišný se odmítne. Lokální acceptance/výsledek se uloží transakčně. Handle/relay doručování má trvalý outbox a stabilní message ID. Přijaté serverové operace dokončuje backend podle původní autorizace i po výměně agenta.

Masumi pending nebo timeout navazuje na původní intent, purchaser nonce, input hash a provider IDs. B nejprve čte/reconciliuje stav; nový case, inkaso či token nejsou retry. Částky, wallet, příjemce, síť/asset a zákaznický souhlas se nemění. Externí escrow není součástí SQLite transakce: dispatch fence, ověřené pozorování a explicitní recovery/refund zůstávají povinné.

Přímý browser zápis v cizím systému tyto vlastnosti automaticky nemá. Po přerušeném kliknutí, timeoutu či nejasném výsledku se operace uloží jako `uncertain` a nejprve se dohledá v cílovém systému. Bez potvrzení výsledku se neopakuje a B ji nepřebírá novým zápisem; případně rozhodne člověk. Automatický zápis lze označit za podporovaný až s ověřenou identitou, souhlasem, kontrolou výsledku a konkrétními retry/revocation limity. Univerzální atomický commit přes všechny admin UI není cílem dema. Reset nesmí odstranit živou/nejistou platbu nebo nejistý zápis ani obnovit revoked přístup.

## 8. Mandát zákazníka a schválení majitele

Zákaznický GrokBot převede zadání do návrhu strukturovaného mandátu. Po discovery doplní ověřenou cílovou firmu a konkrétní platební podmínky/mapping. Zákazník pak úplný mandát pro test jednou potvrdí ve svém autentizovaném zobrazení, vždy před přijetím nabídky a platebním dispatch. Automatické parsování věty ani původní návrh nejsou samy oprávněním utrácet.

```json
{
  "mandate_id": "mandate-007",
  "customer_id": "customer-007",
  "mode": "book",
  "service_id": "tyre_change",
  "service_spec": {
    "vehicle_type": "personal",
    "wheel_size_inches": 18,
    "rim_type": "alu",
    "runflat": false,
    "tpms": false,
    "wheel_count": 4
  },
  "service_area": "demo-prague-7",
  "latest_service_end": "2026-10-16T18:00:00+02:00",
  "max_total_minor": 230000,
  "max_deposit_minor": 50000,
  "currency": "CZK",
  "allow_extras": false,
  "expires_at": "2026-10-09T08:00:00+02:00",
  "status": "human_approved"
}
```

Uvedené datumy jsou seed pro původní termín hackathonu. Pro nový běh musí zůstat mandát platný vůči hodinám prostředí. Termín samotné služby je pozdější. Identita cílové firmy se ověří po discovery, samotný kontakt neuděluje platební oprávnění. Schválení mandátu agent nesmí zapsat sám.

Režimy:

- `recommend`: nabídku lze vyjednat a předložit, ale nelze rezervovat ani převádět zálohu.

- `book`: rezervace a záloha jsou povolené jen při splnění všech schválených hranic.

Limit se vztahuje na celou cenu, nikoli pouze na zálohu. Částky se ověřují v haléřích. Vedle ceny se ověřuje služba, termín, měna, doplňky, platnost nabídky a platnost mandátu.

Majitel potvrzuje výjimku pro přesné `quote_id`, `quote_version`, cenu, termín, slevu a `rulebook_version`. Agent ani zákazník nemůže jeho podpis simulovat textem. Změna cenové nabídky vyžaduje nové schválení tam, kde je podle pravidel nutné.

Mandát pro Masumi navíc váže provider, Preprod síť, asset/quantity, schváleného příjemce/SKU a strop síťového poplatku. Serverová mapa syntetické ceny služby v CZK na testnet asset je verzovaná a odsouhlasená. Výměna firemního agenta nesmí změnit zákaznické accepted_by/proposed_by, schválené limity, quote binding, síť nebo příjemce. Připravený prompt ani Agent Card nejsou oprávněním použít peněženku.

## 9. Ukázková zakázka

Zákazník zadá:

> Zařiď mi přezutí čtyř mých pneumatik u Pneu 007 na [testovací adresa z kontaktu] nejpozději v pátek 16. října 2026. Osobní auto, 18″, hliníkové disky, bez runflat a TPMS. Celkem maximálně 2 300 Kč, záloha maximálně 500 Kč. Nechci uskladnění ani další služby. Pokud splníš tyto podmínky, můžeš rezervaci potvrdit.

Kontakt na fiktivní firmu a její web je předem vložený do relace podle oddílu 6. Endpoint, rulebook a ceny v něm nejsou. Datum se musí při opakování mimo původní hackathon přizpůsobit celému testovacímu seedu.

| Krok | Co se opravdu stane |
| - | - |
| 1 | Customer vytvoří návrh mandátu podle zadání. Dokud neobsahuje ověřenou cílovou firmu a platební podmínky, neuděluje oprávnění nákupu. |
| 2 | Customer vyhledá službu/lokalitu v registry, otevře vrácený web, načte aktuální Agent Card, použije zjištěný endpoint a odešle poptávku. |
| 3 | Business načte aktivní rulebook a ověří službu, cenu 2 472 Kč a dostupnost. |
| 4 | Proběhne výměna nabídky a protinabídky. Agentem povolená 5% sleva dává 2 348,40 Kč, tedy nad zákazníkův limit. |
| 5 | Business uloží konkrétní návrh nabídky s 10% slevou, cenou 2 224,80 Kč, zálohou 500 Kč a přesným quote ID/verzí. Vyžádá owner schválení této nabídky; bez něj ji nevydá jako závazně schválenou. |
| 6 | Majitel schválí uloženou quote/verzi a její podmínky. Business předá zákazníkovi stejnou nezměněnou schválenou nabídku. |
| 7 | Customer ověří nabídku, cílového příjemce, SKU/mapping a platební limity. Zákazník potvrdí úplný vázaný mandát; teprve potom Customer přijme přesnou nabídku. |
| 8 | Business vyvolá commit. Backend znovu ověří pravidla, mandát, schválení, verzi nabídky i volný termín. |
| 9 | Backend uloží jediný intent a rezervaci podrží. Masumi Preprod provede autorizovaný testnet lifecycle; potvrzené pozorování funding dovolí zapsat potvrzený booking. Nejasný výsledek se reconciliuje se stejným intentem. |
| 10 | Customer načte skutečný výsledek a odprezentuje termín, cenu, zaplacenou zálohu, zbývajících 1 724,80 Kč a identifikátor rezervace. |

Celková syntetická cena služby zůstává 2 224,80 Kč, záloha 500 Kč a doplatek 1 724,80 Kč. Masumi používá Preprod testnet asset podle verzované SKU mapy; escrow funding, booking, předání výsledku a seller payout jsou různé stavy. Testnet balance/transaction reference se vykazuje podle skutečného pozorování, nikoliv jako bankovní převod CZK. UI rozlišuje „Masumi Preprod, fiktivní služba“ a „Local_demo simulace“; samotná konfigurace není důkaz platby.

Přesné formulace agentů nesmějí být předem nahrané. Testovací vstupy jsou připravené, výběr kroků a texty vytvářejí skuteční GrokBoti.

Souběhové rozšíření: během kroku 5 jiný zákaznický případ pokračuje a majitel může odděleně získat soukromý přehled tržeb. Konkrétní počet aktivních GrokBot účtů se zaznamená, nepředpokládá.

## 10. Commit a skutečné bezpečnostní hranice

### 10.1 Podporovaná automatická cesta Pneu a Masumi

Pro závazný demo průchod použít vlastní owner-created/approved servisní účet agenta a tenký Pneu transakční MCP nad existujícími zdokumentovanými cenovými/booking/checkout API či doménovými funkcemi, plus Masumi workflow. Stejné HTTP operace jsou ověřený fallback. Auditní browser/admin účet se pro transakční runtime nevyžaduje. MCP nástroje neobsahují lidské owner/customer approvals a nemohou obejít backend policy. Handle/Pneu backend na této cestě kontroluje identity/scopes, active connection/epoch, case ownership, aktivní typovaný rulebook, platnou nabídku, zákaznický mandát/přijetí a přesnou owner výjimku.

1. Ověřit identitu, firemní/zákaznický scope, případ a aktuální epoch.
2. Znovu načíst skutečnou cenu, termín, pravidla, expiry, souhlasy a všechny platební parametry.
3. Přijmout jedinou idempotentní operaci s kapacitním holdem a uloženým intent/nonce/input hash. Lokální efekt a výsledek musí mít transakční nebo unikátní doménový binding.
4. Před externím voláním uložit dispatch fence. Pozorovat/reconciliovat původní Masumi intent; potvrdit booking až podle ověřeného stavu, konflikt řešit explicitně.
5. Vrátit skutečný uložený stav/IDs a doručit výsledek opakovatelným outboxem se stabilní message ID.

Stejný klíč vrací původní výsledek, jiný payload se odmítne; jiný klíč nesmí inkasovat tutéž přijatou nabídku znovu. Externí escrow, relay DB a legacy booking nejsou jednou SQL transakcí. Při prvním nasazení platí jeden autoritativní proces/replica; další writery vyžadují prokázané koordinované fencing.

### 10.2 Externí UI/API/MCP mimo kontrolovaný backend

Report i rulebook uvedou u akce konkrétní cestu a režim: podporovaný automatický zápis, asistovaný/manuální krok, pouze pozorování nebo neověřeno. Přímé administrátorské zápisy mohou obejít Handle guardrails a nemají automaticky jeho idempotenci, izolaci či atomické obsazení kapacity. `readOnlyHint` ani admin login neopravňují neověřené rizikové akce. Takové kroky zůstanou asistované nebo blokované, dokud není ověřen konkrétní bezpečný postup; nebuduje se kvůli auditu nový obecný broker.

Kritická fakta bez nativního version/ETag se před operací znovu přečtou/přezkoumají. Při nejistém externím zápisu se nejprve dohledá původní výsledek a nesmí se naslepo opakovat. Revokace Handle credentials platí jen na kontrolovaných cestách; externí sessions/keys se při předání skutečně zruší/rotují dle §7.8. Nevyřešená nejistota drží dotčené předání/zápisy pending.

Lidská Handle session, aktivace, consent a zákaznický mandát jsou nezávislé autentizované záznamy; legacy admin účet předaný botovi je nevytváří. Credentials a payment master keys nepatří do reportu, karty, promptu, repozitáře ani logů. Owner recovery/refund práva nepřejdou na bota výměnou runtime. Owner-only reset nesmí zničit nejistou platbu/zápis ani obnovit revoked credentials; po externím finančním kroku se neobnovuje slepě starý DB snapshot.

### 10.3 Volitelná lidská platba přes Link by Stripe v testovacím režimu

Na výslovný požadavek uživatele z 9. října 2026 přidáváme tlačítko Link by Stripe do výběru platební metody checkoutu pro člověka, s existujícím testovacím účtem Stripe produktu Handle. Člověk před přesměrováním vidí konkrétní objednávku, částku zálohy, měnu CZK a označení testu a sám platbu potvrdí ve Stripe Checkout; agent za něj nepoužívá platební údaje ani nepotvrzuje souhlas. Tato cesta používá nativní testovací CZK evidenci, ne mapping na ADA, a nenahrazuje agentí Masumi Preprod workflow, mandáty ani jeho důkazy. Produkční klíče, live platby a skutečné peníze jsou mimo tento rozsah. Objednávka má jediného trvale přiřazeného platebního providera; retry, restart, timeout ani souběh Stripe/Masumi nesmějí vytvořit druhé inkaso. Nejasný výsledek se nejprve dohledá u původního providera.

Stripe je autoritou platebního stavu. Backend ověří podpis webhooku nebo načte stav serverovým autentizovaným Stripe API a před označením zálohy za zaplacenou zkontroluje testovací režim, správný merchant účet, vazbu Checkout Session/platby na objednávku, částku, měnu a skutečný platební stav. Návratová URL, klientské tvrzení ani vytvořená session nejsou důkazem úhrady. Opakované události nesmějí zapsat zálohu podruhé. Zaplacení ve Stripe testu není bankovní payout ani skutečný příjem Kč; zapnutí tlačítka nedokládá dokončený Link test. Důkaz konkrétní metody Link, session/platby, času a pozorovaného výsledku se vykazuje samostatně bez tajemství.

## 11. Rozdělení práce mezi tři lidi

### Člověk A: business, audit a chování agentů

Doporučeně Dušan, pokud chceš držet scénář a rozhodování agentů.

Odpovědnost: "Agenti chápou zadání a firemní pravidla vznikla z doložených vstupů."

Dodá:

- Obsah demo webu/interních dokumentů a reprezentativní přístupy do alespoň dvou nezávislých legacy administrací; zachovat styl Pneu 007 a ověřený ceník.

- Bootstrap zadání pro fresh firemního GrokBota, auditní úkol, práci s neznámými a požadované veřejné/canonical výstupy.

- Obecný auditní report, systémový inventář, redigované citované přílohy a návrh podporovaného rulebooku/SKILL.md; majitel přezkoumá fakta i autoritu.

- Testovací kontakt s adresou a webem bez endpointu, ceny a interních pravidel.

- Zákaznické zadání, oba režimy mandátu, důkazy z auditu a negativní test pravidla.

- Instrukce oběma GrokBotům v koordinaci s člověkem B.

- Scénář anglického dvouminutového dema a popis toho, co je sandboxové.

První předání: data, příklad požadavku a očekávané výsledky kolegům. Nečekat na crawler ani UI.

### Člověk B: propojení GrokBotů a discovery

Odpovědnost: "Dva oddělené účty si skutečně předávají úkol a po přerušení pokračují."

Dodá:

- G0 runtime test, discovery bootstrap, agent registration/owner consent, automatický managed relay a ověřenou dostupnost privátního inboxu.

- Obecný klient pro načtení Agent Card a veřejný A2A adaptér podle ověřené verze.

- HTTPS relay engine, scoped persistent relay resources, autentizované zprávy, inboxy, případy a fenced frontu. Žádný povinný registr.

- Upozornění, potvrzování zpracování, ochranu před duplicitami a omezení počtu výměn.

- Souběh A/B, oddělený interní kanál majitele a záznam skutečných omezení runtime.

- Handle generování/ověření karty a agentem provedenou publication dostupným CMS/hostingem/API/MCP; dynamic route/proxy nebo pravdivé static withdrawal_pending, změnu endpointu/cache a oficiální konformitní testy.

- Záznam integračního testu a úvodní sestavení aplikace na společném serveru.

- Zobrazení konverzace a událostí v API, ze kterého čerpá konzole.

První předání: funkční "požadavek → odpověď" mezi dvěma účty, ještě bez autoservisu.

### Člověk C: testovací systémy, vynucení pravidel a lidská konzole

Odpovědnost: "Řízená Pneu/Masumi cesta vynucuje oprávnění a jediný závazek; externí cesty mají přiznané limity a recovery."

Dodá:

- Cenový systém, booking, dummy data, supplier mocks a Masumi Preprod; stejnou cenovou logiku a local_demo označení. Vlastní per-agent servisní účty a tenký Pneu transakční MCP/HTTP nad stejnými backend guardrails; bez broad admin či lidských approval nástrojů.

- Validaci podporovaných parametrů rulebooku, mandátu a cenové nabídky.

- Lidské owner binding/consent, schválení rulebooku, runtime scopes, website grant, mandátu a cenové výjimky.

- Idempotentní checkout/hold, payment reconciliation, skutečný stav v UI, bezpečný reset a actor/connection odvolání.

- Testy zákazů, opakovaného provedení, expirace a atomického obsazení termínu.

- Autorizaci řízených případů, firm-owned kontext a předání včetně externí revokace/nejistých zápisů; oddělený přehled tržeb s definicí metriky.

První předání: stejný commit jednou selže bez schválení a po správném schválení jednou uspěje, i když jsou agenti zatím nahrazeni testovacím HTTP klientem.

### Práce společně

Prvních 15 minut odsouhlasit datové kontrakty a názvy stavů. Člověk B spravuje jejich společný soubor. Po odsouhlasení se kontrakty mění pouze domluvou všech dotčených, ne samostatným přejmenováním na jedné větvi.

A připravuje skutečné rozhodovací případy. B a C proti nim vyvíjejí souběžně. Agenti se připojí až na stabilní kontrakt, ne na tři rozdílné sady endpointů.

## 12. Rozhraní, na kterých se tým dohodne jako první

V `packages/contracts` společně definovat:

| Typ | Minimální pole |
| - | - |
| `BusinessProfile` | business_id, services, systems, processes, partners, findings |
| `Rulebook` | business_id, version, status, evidence references, podporovaná typovaná rules, enforcement paths, approved_by/at |
| Auditní report/přílohy | report version, system inventory, fact/finding, evidence_id, URL/system/screen/locator, observed_at/method, excerpt/capture, stored hash, native version pokud existuje; přes stávající version storage |
| Veřejná Agent Card | Použít schéma zvolené ověřené verze A2A. Interní konfigurace: identita, schopnosti, endpoint, protokol, auth, active. |
| `KnownBusinessContact` | demo flag, název, testovací poštovní adresa, website URL. Bez endpointu a pravidel. |
| `Task` | task_id, context_id, authenticated participants, customer_id, business_id, state, request, mandate_id, final_result |
| `WorkItem` | business/case/task, customer owner, connection, claim epoch/generation, lease token hash a expiry, accepted reply a stable message_id. |
| `OwnerQuery` | owner identity, soukromý případ, datum reportu, definice metriky, oprávněný příjemce |
| `Message` | message_id, task_id, sender, recipient, type, payload, in_reply_to, processed_at |
| `Mandate` | customer_id, mode, allowed service, service_spec, limits, deadline, extras, currency, expiry, approval |
| `Quote` | quote_id, version, task_id, slot, service_spec, pricing_version, line_items, base_total_minor, price, deposit, discount, expires_at, rulebook_version |
| `Approval` | actor_role, actor_id, exact target and version, decision, validity |
| `CommitResult` | operation_id, order_id, intent_id, observed payment state, booking_id pokud potvrzen, price, deposit, balance_due a případný recovery stav |
| `AgentConnection` | principal_id, business_id, connection_id, lifecycle, scopes, credential references, ověřené capabilities a execution_epoch |
| Pneu servisní přístup | per-agent service account, owner creation/consent, connection binding, explicitní scopes, MCP/HTTP capability evidence a native revocation; bez broad admin/owner/customer approval |
| `OnboardingRequest` | request/principal, legacy target, provisional scope/expiry, ověřený owner consent, status |
| `RelayResource` | relay_id, business_id, endpoint, private inbox, provision idempotency, readiness/activation state |
| `WebsitePublication` | business/legacy origin, card revision/hash, approved rulebook, zaznamenaný souhlas, method dynamic/static, state včetně withdrawal_pending, veřejné verify evidence |
| `BusinessContext` | schema version, report/evidence/profile/rulebook, system inventory, supported-write matrix, capabilities, cases/approvals, pending/uncertain operations a snapshot/event cursor |
| `Handoff` | business, from/to connections, epoch, owner decision, externí revocation/session evidence, unresolved writes, pending/complete state a event/outbox |
| `PaymentIntent` | původní nonce/input hash, order, customer authorization, provider/SKU/network/asset/recipient/fee cap, dispatch a observations |

Současné moduly repozitáře:

```text
AGENTS.md               # vstupní odkaz na společné finální zadání
apps/legacy/            # Pneu web/backend a první Handle integrační moduly
apps/relay/             # A2A engine, tasks, privátní inbox a leases
apps/registry/          # volitelný directory/discovery kanál
packages/contracts/     # společné typy a validační kontrakty
packages/demo-garage/    # ceník, objednávky, booking, seed a supplier mocks
packages/audit/          # obecný report/evidence, verzovaný rulebook a aktivace
packages/payments/       # Masumi Preprod a explicitní local_demo provider
packages/agent-client/   # HTTP/discovery/A2A klienti
fixtures/               # existující demo business a interní podklady
prompts/                # odvozené auditní a provozní instrukce
skills/                 # onboarding/nástroje konkrétních adaptérů
docs/scope-of-work.md    # kanonická produktová a technická specifikace
docs/runtime-proof.md   # doložený runtime průchod
```

## 13. Implementační plán a návaznosti

Detailní realizační plán je uložený v HTML: `.omx/plans/handoru-onboarding-agent-portability-implementacni-plan.html`; jeho čitelná publikovaná kopie je na [online plánu Handle](https://earthy-raven-ny6e.here.now/). Rozpracované technické návrhy a odhady se řídí touto společnou specifikací.

Nejdříve ověřit aktuální stav a migraci, oddělit business/agent identity a zavést společnou autorizaci a fenced operace. Nad tím vzniknou obecný report/evidence upload, skutečný onboarding, automatické relay provisioning, kanonický context/rulebook, handover s externí revokací a publication dostupnou správou webu. Vlastní auditní konektory nejsou podmínkou. Konzole propojí tyto průchody; konformita, clean-start, crash/recovery a živé runtime/payment důkazy rozhodnou o připravenosti.

Časové omezení může omezit volitelné UI detaily, další runtime adaptéry nebo registry discovery. Nemění povinnost skutečného onboardingu, auditu, lidských souhlasů, webového discovery, bezpečného obchodního zápisu a pravdivého vykázání výsledku.

## 14. Akceptační testy

| ID | Scénář | Očekávaný důkaz |
| - | - | - |
| T01 | Audit vytvoří pravidlo slevy | Ukáže konkrétní citaci/přílohu, systém/čas/metodu, limit a lidské posouzení autority/schválení; nevyžaduje fixture source ID. |
| T02 | Změna zdroje 5 % → 3 % | Agent zdroj znovu přečte a uloží důkaz; po lidském schválení 4% sleva vyžaduje majitele bez ruční backend úpravy. Chybějící politika není odvozena z historie. |
| T03 | Firma dosud nemá schválený rulebook | Není dostupná jako aktivní transakční agent; nevydává aktivní kartu ani aktivní odkaz. Privátní relay probe neotevírá zákaznický provoz. |
| T04 | Klient má službu/lokalitu a zákaznický skill s registry URL | Vyhledá skutečný aktivní listing, načte vrácený web/aktuální kartu a použije její endpoint. Prázdný výsledek/chyba se nenahrazuje hardcoded firmou. Přímý website kontakt se ověřuje jako alternativa. |
| T05 | Hlavní zadání do 2 300 Kč | Vyjednání, schválení 10% slevy, cena 2 224,80 Kč, jedna rezervace. |
| T06 | Režim recommend | Vrátí nabídku, žádný booking a žádný převod zálohy. |
| T07 | Sleva nad autonomní limit bez majitele | Stejné backend kontroly zablokují přímé HTTP i Pneu MCP volání servisního účtu; přímé externí admin UI nemá tuto garanci a není schválenou cestou k obcházení. |
| T08 | Nabídka nad zákazníkův limit | Není přijata ani zaplacena, vyžaduje nové zákaznické rozhodnutí. |
| T09 | Agent se pokusí sám schválit výjimku | Agentí token i legacy admin credentials/cookie jsou pro lidskou Handle aktivaci a approval odmítnuty. |
| T10 | Opakovaný commit nebo dvojité doručení | Řízená Pneu/Masumi cesta vrátí původní operation/intent/booking IDs bez dalšího charge; změněný payload se odmítne. Externí nejistý browser zápis se neopakuje naslepo. |
| T11 | Nabídka expirovala nebo termín mezitím obsazen | Bez potvrzení, nový návrh nebo srozumitelný neúspěch. |
| T12 | Čtení cizího inboxu, mandátu nebo soukromého rulebooku | Odepřený přístup. |
| T13 | Zpožděné schválení majitele | Úkol zůstane uložený, pokračuje až po načtení platného rozhodnutí. |
| T14 | Výsledek platby | Pro aktuální demo obchodní evidence: celkem 2 224,80 Kč, simulovaná záloha 500 Kč, doplatek 1 724,80 Kč; jeden lokální intent a booking, provider `local_demo`, síť `local`, výslovné označení simulace a žádné volání blockchainového nákupu. Samostatný volitelný Masumi test vyžaduje skutečný provider/chain důkaz; lokální simulace jej nenahrazuje. |
| T15 | Změněný endpoint v kartě | Změněná revision/ETag a revalidace při novém běhu vedou na nový povolený endpoint bez změny kontaktu/kódu; oddělené legacy/relay originy fungují, cizí origin nedostane původní token. |
| T16 | Chybějící/nekompatibilní karta | Konkrétní chyba, žádné vymyšlené spojení nebo tichý hardcoded fallback. |
| T17 | Zákazník A čeká na majitele | B mezitím pokračuje ve vlastním případu. Bez přimíchání informací A. |
| T18 | Interní dotaz na tržby při zákaznické práci | Přehled s datem a definicí metriky pouze majiteli. Zákaznický přístup k nástroji odmítnut. |
| T19 | Dva zákazníci přijmou stejný poslední termín | Na řízené Pneu checkout cestě jedna rezervace, druhý konflikt bez dalšího převodu; externím admin UI se atomická garance nepřisuzuje. |
| T20 | B se pokusí přečíst případ A | Odepření serverem. Test nelze vydávat za ověření izolace dlouhodobé paměti modelu. |
| T21 | Restart po commitu před odpovědí | Řízený backend vrátí původní booking/intent ID bez další platby; nejistý externí UI zápis má pending reconciliation. |
| T22 | Veřejný A2A adaptér | A2A 1.0 JSON-RPC karta na legacy doméně i endpoint projdou kompatibilním oficiálním a2a-tck se skutečným reportem/verzemi; inspector doloží výměnu zpráv. Bearer je vynucen, wire auth union odpovídá schématu, streaming/push zůstávají false bez vlastního důkazu. |
| T23 | Kalkulátor Pneu 007 proti referenci | Každá podporovaná cenová kombinace a závislost voleb odpovídá zachycené referenci; UI i agent vracejí tutéž cenu ze stejné verze ceníku. |
| T24 | Přepočtený hlavní scénář | Seed, mandát, T05/T14, sleva, záloha a doplatek si odpovídají; nutné schválení majitele zůstává součástí průchodu. |
| T25 | Web Pneu 007 a nezávazná poptávka | Požadovaný vizuální styl je čitelný na mobilu i desktopu; kalkulace a testovací poptávka fungují, samotná poptávka nevytváří rezervaci ani platbu. |
| T26 | Čistý první den | Naplněný legacy + fresh bot + instrukce/URL; žádný platformový firemní účet, vazba, relay, předem přidělený business token, audit, rulebook ani aktivní karta. Bot sám zahájí podporovaný bootstrap a registraci. |
| T27 | První owner účet a consent | Člověk se nezávisle autentizuje v Handle a potvrdí firmu/scopes; bot nemůže použít jemu předané legacy admin credentials/session jako lidské proof. Pairing replay/expiry/audience se odmítají. |
| T28 | Relay přes API bez ručního hostingu | Agent po consentu vyžádá relay/inbox; retry, souběh a restart zachovají jediný relay a stabilní endpoint. Majitel nezakládá hosting ani nekopíruje endpoint/token do promptu. |
| T29 | Příjem práce a pravdivá runtime readiness | Po lidské aktivaci agent provede rulebook probe se stávajícím auditním credentialem ještě bez provozního grantu a webhooku; provozní grant před probe selže, webhook před grantem zůstane blokovaný a po grantu lze zahájit jeho registraci/ověření. Skutečný bot přečte a zodpoví izolovaný probe z privátního inboxu, doloží polling/routine nebo ověřený wake-up. Aktivní relace se nevydává za bezobslužný provoz. |
| T30 | Publication souhlas a skutečná technická práva | Bot má zaznamenanou autorizaci karty/odkazu, může být z onboardingu. Nativní Pneu site API/MCP bez publication scope nebo aktivního rulebooku zápis odmítne a mění jen descriptor/odkaz. U cizího broad CMS admina jde o zaznamenaný souhlas a pracovní postup, nikoliv zaručený serverový zákaz jiných editací. |
| T31 | Publikace, částečný zápis a odvolání | Veřejné ověření karty i odkazu, žádné secrets. Dynamická route správně gateuje; statický export je po revoke withdrawal_pending do skutečně ověřeného stažení/aktualizace. Relay blokuje transakce i se starou kartou; nejistý UI zápis se nejprve dohledá. |
| T32 | Kontext patří firmě | B s owner-approved scope načte report/evidence/inventář/rulebook/případy; bez něj nic. Shodný stored hash neprokazuje aktuálnost, kritická fakta ověří nativní verzí či novým čtením bez opakování celého auditu. |
| T33 | Majitelem schválené A → B | B po dokončené interní i externí revokaci pokračuje ve stejném case/quote/rulebook a platném rozhodnutí. Identita zákazníka, mandát a payment intent se nemění; nevyřešené externí sessions/zápisy drží předání pending. |
| T34 | Odvolání starého agenta a lease | A selže na řízených tools/relay/doorbell i otevřeném long-poll; starý lease/env token se neobnoví. Externí admin sessions se ověří samostatně, Handle revoke je automaticky neruší. |
| T35 | Handover během pending/nejisté platby | Blokovaný dispatch/observe, timeout a opožděný výsledek zachovají jediný původní intent/nonce/input hash, nejvýše jedno inkaso a jednu rezervaci. Lokální fault injection a skutečný Masumi Preprod důkaz se vykazují odděleně. |
| T36 | Pád mezi autoritou, relay a odpovědí | Na řízených cestách A po cut-overu nic nového neprovede, outbox obnoví původní IDs a jednu stabilní reply message pro čekajícího i pozdního klienta. Externí nejisté zápisy čekají na dohledání. |
| T37 | Firemní a kandidátská izolace | Handle/Pneu data/relay tasks jsou oddělená podle firem i pro stejného zákazníka. Audit-only/kandidát neprojde jejich mutacemi. Široké legacy admin právo se nepovažuje za automaticky serverově read-only. |
| T38 | Bezpečné vydání a získání credentials | Provisional exchange je scoped a odolný replay/souběhu/revocation. Tokeny nejsou v kartě, chatu, URL, logu ani HTML. Zákaznický bot získá vlastní token skutečným auth flow a nepřenese jej na jiný nepovolený origin. |
| T39 | Audit více nezávislých systémů bez custom connectoru | Fresh GrokBot s poskytnutými admin účty zmapuje alespoň dvě odlišná legacy UI a veřejný web, případně existující API/OpenAPI/MCP. Inventář/report/citace vzniknou reálně; žádný povinný Pneu export ani adaptér pro každý systém. |
| T40 | Důkaz, autorita a aktuálnost | U závěru lze otevřít neměnný redigovaný výňatek/capture s URL/system/screen/locator/časem/metodou. Hash kontroluje uložené bytes, ne externí pravdu. Majitel posoudí autoritu; chybějící policy neodvodí historie; kritický fakt bez nativní verze se znovu přečte. |
| T41 | Admin vs lidská role a řízený Pneu runtime | Legacy admin cookies neschválí Handle owner vazbu/rulebook; audit je pozorovací a readOnlyHint nepovolí riziko. Owner-created/approved per-agent servisní účet přes Pneu MCP i stejné HTTP používá shodné backend pravidla/mandát/idempotenci, bez approval nástrojů a broad admin. Skutečný MCP/GrokBot test je oddělen od HTTP fallbacku a asistovaných externích zápisů. |
| T42 | Externí revokace a nejistý browser zápis při předání | Handle revoke nechá externí session testovatelně živou, dokud se skutečně nezruší/rotuje nebo neodřízne kontrolovanou cestou. Při neověřené revokaci či timeoutu po kliknutí zůstává handover/retry pending; B nejprve dohledá výsledek a nevytvoří druhý zápis/charge. |
| T43 | Volitelný lidský Link by Stripe test checkout | Člověk potvrdí zobrazenou objednávku/zálohu v CZK přes Link v testovacím Stripe Checkout. Podpisem ověřený webhook nebo autentizované serverové načtení doloží správný testovací účet, session/payment ID, objednávku, částku, měnu, paid stav a skutečně použitý Link. Zrušení, pouhý návrat na success URL, neplatný podpis, cizí účet nebo nesouhlas částky/měny úhradu nepotvrdí. Replay/restart/souběh zachová jednu zálohu a původního providera; druhý Stripe/Masumi charge téže objednávky se odmítne. Testovací ledger je oddělený od ADA mapy i bankovního payoutu a Masumi/agentí mandáty zůstávají zachované. Bez dokončeného externího testu uvést NOT_RUN/BLOCKED. |

Základní demo musí projít T01 a T03–T16, T19–T25 a cílový onboarding/předání T26–T42. T02 dokládá, že audit není předem napsaný, a má být součástí důkazů. T17 a T18 ověřují rozšířený scénář souběhu a interní agendy. Případné odložení živého předvedení tohoto scénáře uvést výslovně. Backendové kontroly izolace a kolizí nejsou volitelné. Testy označovat PASS, FAIL, NOT_RUN nebo BLOCKED s odkazem na důkaz, ne pouze zaškrtnutím v dokumentaci.

Je-li některý test neprovedený nebo neprojde, uvést to v `limitations.md`. Nepoužívat nahrané video jako náhradu pravdivého popisu stavu aktuálního buildu.

T43 ověřuje samostatnou volitelnou lidskou platební cestu podle §10.3; její výsledek nenahrazuje T14 ani důkaz agentí Masumi Preprod transakce.

U každého externího výsledku zaznamenat skutečný runtime/účet bez tajemství, metodu přístupu/verzi API či MCP a protokolu, report/evidence/rulebook hash, čas a návazná ID. Skriptovaní klienti a lokální providery jsou důkaz backendu; nejsou důkazem živého GrokBota, jiného konkrétního produktu ani on-chain transakce. Bez přístupu k účtům, prostředí nebo funds uvést NOT_RUN/BLOCKED a konkrétní závislost.

## 15. Konzole a dvouminutové demo

Veřejná stránka `/handle/get-started` je dostupná před přihlášením. Přihlášený majitel otevírá Začínáme jako interní záložku `/handle#get-started` se stejným shellem jako ostatní záložky, bez přechodu na samostatnou stránku. Odděluje firemní managed onboarding a zákaznické registry discovery, nabízí kanonické kopírovatelné instrukce, uvádí potřebné lidské souhlasy, vlastní token agenta, oddělený publisher přístup, ověřený webhook a omezení Pneu-only. Checklist připravenosti je vysvětlení, nikoli automatické potvrzení neprovedených živých testů. Připravené open demo je označená alternativa, ne náhrada auditu.

Záložka Agent Card obsahuje jednoduchý popis a tlačítko pro zkopírování kanonického zadání. Prompt doplní aktuální website/Handle URL a zachová soukromý token mimo veřejnou kartu. Stav a historie publikace jsou ve sbalitelném detailu.

Konzole ukazuje onboarding a ověřeného vlastníka, přidělený relay/příjem práce, zdroje a audit, rulebook/schválení, website publication, připojené agenty/předání a uložené objednávky/platby. Každý pohled má konkrétní stav a další potřebný krok. Nevyvíjet vlastní náhradu plného chatového UI GrokBota.

Časová osa ukazuje pozorované zprávy a skutečné události. Nezobrazuje domnělé vnitřní uvažování modelu. U každé události lze otevřít pravidlo, schválení nebo výsledný záznam, který ji dokládá.

### Doporučený střih

| Délka | Záběr |
| - | - |
| 0–20 s | Fresh bot + legacy, vlastní registrace/provisioned relay a audit se zdrojem; lidská aktivace a agentem publikovaná karta/odkaz. |
| 20–40 s | Požadavek v reálném zákaznickém GrokBotovi, známý kontakt a živé načtení webu/Agent Card. |
| 40–70 s | Obě identity, skutečné zprávy, nabídka nad limit a protinabídka. |
| 70–90 s | Majitel schválí konkrétní výjimku, agenti automaticky pokračují. |
| 90–110 s | Booking ID, cena 2 224,80 Kč, sandboxová záloha 500 Kč a potvrzení zákazníkovi. |
| 110–120 s | Zablokovaný nepovolený krok a přesné vymezení dema. |

Krátká anglická věta do dema:

> Two real personal agents negotiate a service. The business agent uses rules extracted from the business, asks its owner for an exception, and completes a sandbox booking within the customer's mandate.

Závěrečná obrazovka: "Real GrokBots. Fictional business. Known contact, live endpoint discovery. Sandbox payment." Pokud běží jen aktivní polling relace, přidat "Pre-started agent sessions, not unattended wake-up."

Doplňující důkazy mimo dvouminutový střih: celý fresh onboarding bez vývojářem předvyplněných údajů, A→B předání téhož případu, A čeká a jiný zákazník pokračuje, majitel dostane vlastní přehled. Doložit použitá skutečná prostředí a odlišit testovací HTTP klienty.

## 16. Mimo scope

První verze nevyžaduje:

- Univerzální podporu všech agentích produktů nebo neověřenou podporu Muse/Dots. Přenosný kontrakt a výměna dvou ověřených agentích připojení jsou v scope; konkrétní runtime se označí za podporovaný až po vlastním živém průchodu.
- Produkční platby v mainnetu, skutečné zákaznické údaje nebo poskytování reálných autoservisních služeb. **Masumi Cardano Preprod a pravdivý důkaz sandboxové transakce jsou v scope.**
- Univerzální audit bez přístupů z jediné veřejné URL, vlastní Pneu audit konektor, per-CRM adaptéry nebo nový obecný source registry/broker. Povinný je skutečný pozorovací audit více zpřístupněných systémů a obecný report/důkazy; Účelový Pneu transakční MCP a per-agent servisní účty nad nativními policy-checkovanými API jsou v scope; nenahrazují obecný audit ani nepředstavují per-CRM audit connector.
- Samostatného dodavatelského agenta a autonomní nákup dílů. Audit fiktivních partnerů a funkční testovací supply-chain data zůstávají součástí dema.
- Globální registr/marketplace, organickou indexaci nebo univerzální certifikaci firemní identity. Samostatná lidská Handle autentizace/consent, první owner účet a bezpečný zákaznický auth jsou povinné; legacy admin účet poskytnutý botovi je nenahrazuje.
- Všechny volitelné funkce A2A. Deklarovat jen ověřený rozsah; streaming/push jsou nejprve false. Vlastní protokol nevydávat za A2A.
- Vlastní deployment Handle na účtu každého majitele. Handle/relay engine provozuje náš tým; agentí vytvoření firemního relay přes API je povinné.
- WebMCP, pokud nezjednodušuje ověřené připojení konkrétního nástroje.
- Nahrazování SaaS, billing platformy, obecný produktový CRM a hotové multitenantní produkční řešení. Oddělení firem, oprávnění a základní izolace se testují už v demu.
- Záruku produkční izolace dlouhodobé paměti modelu bez samostatného ověření runtime.
- Obecný systém reklamací a sporů. Recovery pending platby, explicitní kompenzační stav a zabránění duplicitnímu inkasu při retry/předání nelze tímto bodem vyřadit.

Fresh onboarding, lidský consent, audit a aktivace pravidel, zaznamenaný publication souhlas, agentem provedené zveřejnění karty/odkazu a bezpečné majitelem schválené A → B jsou požadovanou součástí této specifikace, nikoli odložené produkční funkce. Jejich stav musí odpovídat skutečným testům.

## 17. Rizika a omezení, která zveřejnit

Nejvyšší integrační riziko zůstává skutečný runtime: příjem práce, probuzení, bezpečné credentials a návrat odpovědi. Aktivní relace není automaticky bezobslužná dostupnost. G0 a živé runtime důkazy mají přednost před rozšiřováním UI.

Připravená business data nejsou hotový audit. Report a pravidla musí vzniknout skutečným prohlédnutím UI/API/MCP a doloženými závěry. Upload, stored hash nebo modelová jistota nepotvrzují externí pravdu či autoritu. Majitel musí závěry přezkoumat; chybějící politiku nelze odvodit z historie. Bez nativních verzí je potřebné nové čtení kritických faktů, nikoli tvrzení univerzálního live monitoru.

Admin účty mohou dovolovat zápisy. Pozorovací audit a publication omezení jsou v takovém případě postup a zaznamenaný souhlas, nikoli serverově zaručené read-only/narrow scope. Lidský Handle účet a approval se musí autentizovat nezávisle na účtech/cookies dostupných botovi. MCP hint není bezpečnostní hranice.

Pneu řízené booking/checkout API s Masumi mají konkrétní vynucování, durable intent/outbox a reconciliation. Přímé browser/admin mutace v cizích systémech mohou tyto guardrails obejít; nesmějí být vydávány za univerzálně atomické/idempotentní zápisy. Každá cesta má podporovaný/asistovaný/neověřený stav. Nejistý zápis čeká na dohledání, neopakuje se naslepo.

Revokace Handle připojení nezruší externí sessions/keys. Předání zůstane pending, dokud nejsou skutečně odvolané/rotované nebo ověřeně odříznuté kontrolovaným nástrojem a nejisté zápisy vyřešené. B nesmí vytvořit druhou objednávku či charge. Secret rotation může vyžadovat asistovaný krok člověka.

Publikace používá dostupnou správu webu; chybějící write možnost není skryta za tvrzením hotového konektoru. Dynamická route/proxy na managed kartu usnadní gating. Statický JSON/CDN může po revoke přetrvat; do ověřeného odstranění je withdrawal_pending. Relay i tehdy blokuje neautorizované transakce.

Zákaznický bot standardně získá firmu z registry search, endpoint ale objeví živě z aktuální karty. Neprokazujeme automatické organické vyhledání nebo univerzální kompatibilitu libovolného klienta. Runtime-neutral přenos není důkaz podpory Muse/Dots; konkrétní produkt má vlastní průchod. Serverová izolace nezaručuje izolaci dlouhodobé paměti modelu; používat syntetická data.

Masumi Preprod důkaz je oddělený od local_demo; nejasný finanční stav se neodvozuje z chatu ani neřeší obnovením starého DB snapshotu. Testnet částky a fees se nepředstavují jako bankovní Kč. Skutečná infrastruktura Handle musí existovat před fresh onboardingem; provision firemního relay není nasazení celé platformy.

## 18. Hotové zadání pro auditního a provozního agenta

Instrukce používají skutečný Handle bootstrap a již dostupné UI/API/MCP. Nepředpokládají vlastní audit connector, předem připravený report ani business token.

### Fresh firemní GrokBot: připojení a relay

> Připoj se k Handle na [URL] a připrav obsluhu firmy. Načti bootstrap, založ vlastní agentí účet a onboarding žádost a pošli mi verification odkaz/kód. Lidskou Handle roli si nepřiděluj; poskytnuté legacy admin účty ani cookies nejsou moje Handle session nebo souhlas. Po mém nezávislém potvrzení firmy/scopes přes API idempotentně vyžádej relay a privátní inbox. Ověř příjem/odpověď a dostupný polling/routine. Netvrď trvalou obsluhu, pokud funguje jen aktivní relace. Credentials drž mimo chat/report. Chybějící capability pojmenuj a zákaznické transakce před aktivací nespouštěj.

### Firemní GrokBot: skutečný audit

> Dostaneš URL a admin účty do našich existujících systémů. Pozoruj veřejný web a jednotlivé administrace; použij existující zdokumentované API/OpenAPI či MCP, je-li dostupné. Nevyžaduj vlastní Handle/Pneu connector a nevytvářej zkušební mutace. Široký admin přístup ani MCP readOnlyHint nejsou souhlasem k rizikové akci. V obecném reportu sestav inventář systémů, nabídku/ceny, procesy, partnery, role, autoritu, neznámé a rozpory. Ke konkrétním závěrům přilož relevantní redigovaný výňatek/capture a cituj systém/URL/obrazovku či locator/čas/metodu; nativní verzi uveď jen pokud existuje. Ulož report a neměnné přílohy do firemního prostoru. Stored hash dokazuje bytes přílohy, ne externí pravdu. Chybějící slevovou či jinou politiku neodvozuj z historie. Polož mi konkrétní otázky a navrhni pouze podporovaná typovaná pravidla a konkrétní provozní cesty. Vyčkej na můj přezkum faktů/autority a aktivaci přesné verze.

### Firemní GrokBot: publikace karty

> Po lidské aktivaci a zaznamenaném publication souhlasu vezmi validovanou kartu z Handle a dostupným CMS/file managerem/hostingovým UI či existujícím API/MCP publikuj /.well-known/agent-card.json a viditelný přímý odkaz Pro agenty. Preferuj standardní route/proxy na managed kartu; vlastní CMS connector není podmínkou. Použij jen povolený rozsah karty/odkazu bez secrets a interních pravidel. Široká admin práva se tím technicky nezúžila. Ověř veřejně JSON, odkaz a relay; částečný/nejistý UI zápis nejprve dohledávej. U statického souboru ověř skutečnou aktualizaci/stažení i cache, do té doby hlásíš withdrawal_pending. Před prvním schválením žádná aktivní karta.

### Firemní GrokBot: provoz

> Jednáš za Pneu 007 jako aktuálně povolený vykonavatel. Používej aktivní pravidla a skutečnou cenu/booking. Automatický demo obchod dělej vlastním owner-created/approved servisním účtem přes Pneu transakční MCP nebo stejné kontrolované HTTP API a Masumi. Provoz nepotřebuje broad admin a MCP neobsahuje owner/customer approval nástroje; guardrails v nativním backendu neobcházej. U jiných cest respektuj supported/asistovaný/neověřený režim a souhlasy. Pracuj jen s přiděleným případem/lease; výjimku připrav pro přesnou nabídku, ulož čekání a uvolni práci. Neschvaluj za člověka. Před závazkem ověř kritická fakta, expirace a mandát. Použij trvalý klíč; pending Masumi intent dohledávej se stejnou nonce, nevytvářej další charge. Nejasný browser zápis označ uncertain a nejprve ověř v cílovém systému. Potvrzuj jen uložený pozorovaný výsledek a rozliš Kč/testnet lovelace. Po revokaci žádné nové kroky; již přijatou serverovou operaci dokončí backend.

### Nástupnický agent: převzetí

> Založ vlastní identitu a požádej o owner-approved kontext, nepřebírej token A. Načti report, přílohy, systémový inventář, pravidla, případy a pending/uncertain operace; ověř kritická fakta a vlastní nástroje. Bez změny důvodů neopakuj celý audit. Před potvrzením jsi kandidát. Handle revoke sám neruší externí sessions/keys: ověř jejich skutečné zrušení/rotaci nebo kontrolovaný přístup. Při nevyřešeném přístupu či nejistém zápisu ponech předání pending a neprováděj duplicitní mutace. Po dokončení převezmi novou epoch/leases a stejné case/quote/operation IDs a stále platné souhlasy. Identitu zákazníka, mandát, příjemce, částky a rozběhnutý payment intent nepřepisuj.

### Zákaznický GrokBot

> Jednáš za zákazníka pouze v lidsky schváleném mandátu. Skill handle-customer dodá registry URL; vyhledej službu/lokalitu a otevři vrácený web. Znovu ověř Agent Card a použij kompatibilní objevený endpoint a skutečný auth flow. Token v kartě není; credential posílej jen ověřené službě se správnou audience, nikoli na cizí origin/redirect. Endpoint ani fallback nevymýšlej. Před přijetím porovnej cenu, zálohu, službu, termín a doplňky s mandátem. Recommend je pouze nabídka; book může přijmout platnou vyhovující nabídku. Vyjednání nezvyšuje rozpočet. Při překročení požádej člověka. Dokončení shrň až po booking ID a ověřeném platebním stavu, rozliš Kč/testnet asset.

### Interní GrokBot majitele

> Pracuješ v soukromém oprávněném kanálu. Tržby načti povoleným nástrojem s datem a definicí, ne z paměti zákaznických konverzací. Výsledek dostane jen majitel. Výjimku či předání připrav pro lidské rozhodnutí, neschvaluj je místo člověka. Legacy admin účet neposkytuje lidská Handle práva ani možnost self-aktivace. Používej vlastní případy a chraň interní data.

## 19. Zdroje k technickým předpokladům

Odkazy [1]–[6] jsou převzaté z původního SOW, odkazy [7]–[8] z navazující diskuse. Nejsou důkazem dostupnosti konkrétního runtime. A2A schema/discovery/caching a oficiální testovací nástroje byly při upřesnění procesu 9. října 2026 porovnány s oficiálními zdroji; jejich implementační použití stále vyžaduje uložené testovací výsledky. Uchovávají dohledatelný původ dřívějších technických tvrzení, nejsou zárukou dostupnosti funkcí. Před implementací ověřit aktuální dokumentaci a konkrétní účty. Obchodní zadání a novější změny discovery/souběhu vycházejí z konverzace, nikoli z těchto externích webů.

[1] Agents 0.0.7: program, termín odevzdání, track Agentic Economy a požadavek označit sandboxovou platbu. [https://agents007.ai/hackathon01/](https://agents007.ai/hackathon01/)

[2] Grok Bot overview: cloudový počítač, browser, filesystem, terminál a práce s nástroji. [https://docs.x.ai/grok-bot/overview](https://docs.x.ai/grok-bot/overview)

[3] Grok Bot for teams and enterprises: sdílení prostředí mezi boty jednoho uživatele, oddělení účtů a konektory. [https://docs.x.ai/grok-bot/teams-and-enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)

[4] Cursor support, 6. října 2026: webhook rutina, URL, klíč, Authorization header a problém jejich zobrazení. [https://forum.cursor.com/t/grok-bot-webhooks-dont-appear-on-desktop-linux-version/173891](https://forum.cursor.com/t/grok-bot-webhooks-dont-appear-on-desktop-linux-version/173891)

[5] Agent Skills specification: SKILL.md, metadata, instrukce a reference. [https://agentskills.io/specification](https://agentskills.io/specification)

[6] A2A Agent Discovery: Agent Cards, discovery přes registry a absence univerzálního API registru. [https://a2a-protocol.org/latest/topics/agent-discovery/](https://a2a-protocol.org/latest/topics/agent-discovery/)

[7] A2A specification, podklad pro ověření veřejné karty a protokolu: [https://a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)

[8] Podklady k otázce souběhu z předchozí diskuse: [https://docs.x.ai/grok-bot/chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) a [https://docs.x.ai/grok-bot/security-faq](https://docs.x.ai/grok-bot/security-faq)

[9] Oficiální A2A conformance suite: [a2a-tck](https://github.com/a2aproject/a2a-tck).

[10] Oficiální nástroj pro kontrolu karty a výměnu zpráv: [a2a-inspector](https://github.com/a2aproject/a2a-inspector).

[11] Realizační plán odsouhlaseného onboardingu, relay, publikace a předání: [Handle implementační plán](https://earthy-raven-ny6e.here.now/).

### Původ a priorita

- Původní `handoru_hackathon_scope_of_work_cs.md` obsahoval registr a vlastní HTTP transport jako první verzi. Jeho nezměněný snapshot je v `reference/scope-of-work-v1.md`.

- Pozdější uživatelský požadavek upřesnil realistické discovery a následně navrhl známou adresu fiktivního servisu.

- Navazující návrh odstranil povinný registr, doplnil URL do výchozího kontaktu a živé discovery na webu. Tuto variantu používá v2.

- Dotaz na souběžné zákazníky a tržby majitele vedl k návrhu oddělených případů, fronty a interní role. Je zahrnutý jako návrh k ověření, ne jako doložená schopnost GrokBota.

- Upřesnění z 9. října 2026 stanovilo managed Handle, agentem zahájené vytvoření účtu/relay, publikování karty na legacy doméně a firemně vlastněný kontext s výměnou runtime. Revize 2.2 zjednodušuje audit na existující multi-system UI/API/MCP a obecný report/důkazy; rozlišuje lidskou Handle identitu, admin přístupy a skutečné hranice zápisů/revokace. Implementační protokoly vykazují stav zvlášť.

### Zbývající vstupy pro tým

Skutečná URL a testovací poštovní adresa, dostupné účty a jejich oprávnění, zvolená ověřená verze/binding A2A, režim probouzení, trvalé hostování testovací DB a definice demo tržeb. Dokud nejsou známé, používat označené placeholdery. Pracovní stack TypeScript + SQLite je návrh, ne prokázaná vlastnost prostředí.
