# Agentic Business Demo — Pneu 007

Funkční demo fiktivního pneuservisu: dodaný webový design, kalkulátor, objednávky, servisní kalendář, dummy zákazníci a historie, sklad a dva simulovaní dodavatelé. Backend poskytuje auditní zdroje a nástroje pro firemního agenta. Agent navrhuje rulebook; majitel jej schvaluje před aktivací autonomních operací.

**Demo web:** https://pneu007-production.up.railway.app  
**Plán:** [docs/pneu-007-plan.html](docs/pneu-007-plan.html)

## Lokální spuštění

Použijte Node.js 22 a npm. SQLite driver se při instalaci může kompilovat a potřebuje standardní C/C++ toolchain.

```sh
npm ci
npm run typecheck
npm test
npm run start:system
```

Web, konzole, legacy nástroje a A2A relay běží společně na `http://127.0.0.1:8797`. Při vývojovém spuštění vzniknou soukromé přístupy v `data/legacy-access.json` (owner, staff, customer-a a customer-b). Tento soubor ani databáze se necommitují. Produkce vyžaduje vlastní environment secrets a persistentní volume; viz [legacy runbook](docs/legacy-runbook.html).

## Struktura

- `apps/legacy`: web, objednávky, kalendář, přihlášení, auditní konzole a sjednocený server.
- `apps/relay`: A2A komunikace a privátní inbox firemního bota; `npm start` spouští samostatný relay.
- `apps/registry`: volitelný registr firem; `npm run start:registry`.
- `packages`: obchodní pravidla, kontrakty, audit, platební adaptéry a agentí CLI.
- `fixtures`: verzované syntetické podklady pro audit; `prompts` a `skills`: instrukce pro reálné boty.
- `infra/masumi`: oddělené testovací buyer/seller uzly a prázdné environment šablony.

## Jeden repozitář pro celý hackathon

Kanonický veřejný repozitář je [zabrodsk/pneu007-business](https://github.com/zabrodsk/pneu007-business). Obsahuje web a backend autoservisu, rezervace, A2A relay, registr firem, nástroje a skills pro GrokBot, audit/rulebook i platební integraci Masumi. Samostatný repozitář `business-agent-registry` byl nahrazen tímto monorepem.

Z tohoto stejného repozitáře se mohou v Railway projektu `pneu007-business` nasadit dvě služby:

| Služba | Dockerfile | Databáze na vlastním volume |
| --- | --- | --- |
| Autoservis, web a A2A | `Dockerfile.legacy` | `/data/legacy.db`, `/data/legacy-relay.db` |
| Registr firem | `Dockerfile.registry` | `/data/registry.db` |

Obě používají větev `main`. Každá má vlastní persistentní volume, secrets a healthcheck `/healthz`. Registr používá `REGISTRY_ADMIN_TOKEN`; produkční konfigurace respektuje Railway `PORT` a odmítne spuštění bez persistentního volume. Na registru ponechte `REGISTRY_HOST` a `REGISTRY_PORT` nenastavené. Root `Dockerfile` slouží pouze samostatnému transportnímu relay; pro obě hlavní služby zvolte Dockerfile z tabulky.

Registry workflow a nastavení popisuje [návod](docs/business-registry.html). Volitelný `.railway/railway.ts` spravuje pouze registry část projektu; existující autoservis zůstává pod současným nastavením Railway. Soubor se při obyčejném pushi sám neaplikuje. Registr zatím není veřejně nasazený.

## Stav integrací

Výchozí platba je **`local_demo` (lokální simulace)**, nikoli ověřená blockchainová transakce. Masumi adaptér cílí výhradně na **Cardano Preprod**; živý platební průchod je **NOT_RUN** do připojení a ověření uzlů a testovacích peněženek. Viz [Masumi setup](docs/masumi-setup.html).

Skutečný audit Pneu 007 a následný nákup dvěma GrokBoty čekají na připojení účtů a provedení integračního scénáře. Dřívější malý komunikační test se zmrzlinovým profilem je popsán samostatně v [runtime proof](docs/runtime-proof.md); není důkazem kompletního pneuservisního průchodu.

## Publikování

GitHub Actions ověřuje instalaci, typecheck a testy na Node.js 22 při pushi a pull requestu. Produkční služba Railway používá `Dockerfile.legacy`, persistentní volume a privátní proměnné služby. Railway služba je propojená s větví `main` tohoto repozitáře. Přímo v nastavení služby se používá `Dockerfile.legacy` (`RAILWAY_DOCKERFILE_PATH=Dockerfile.legacy`), healthcheck `/healthz` a jedna replika. Stav propojení a nasazení popisuje [deployment runbook](docs/railway-deployment.html). Lokální změny se publikují commitem a pushem.

Jde o hackathonové demo bez skutečných autoservisních služeb a bez mainnet plateb. Testovací konstanty v testech jsou syntetické a nesmí se používat jako produkční přístupy.
