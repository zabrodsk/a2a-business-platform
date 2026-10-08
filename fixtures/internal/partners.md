# Pneu 007: dodavatelé a sklad
VERSION: 2026-10-08.1
EFFECTIVE_FROM: 2026-10-08
AUTHORITY: owner-signed-current
OWNER: owner-007

## Pneu Partner Demo
Role: fiktivní distributor pneumatik a spotřebního materiálu. Kontaktní doména pneu-partner.example.com je rezervovaná a neobsluhuje API. Funkční mock API je pouze v našem backendu: GET /api/suppliers/supplier-pneu/catalog a GET /api/suppliers/supplier-pneu/availability. Identita supplier-pneu; SKU DEMO-SKU-001 až DEMO-SKU-005 dle aktuálního katalogu. Dokumentovaný obvyklý lead time: 2 pracovní dny (historický orientační SLA, nikoli příslib aktuální dodávky). Aktuální sklad a ETA rozhoduje legacy-supply a mock API; seed záměrně obsahuje pozdější ETA, aby audit mohl zaznamenat rozpor.

## Servis Parts Demo
Role: fiktivní dodavatel příslušenství a lokální logistiky. Kontakt parts.example.com je pouze syntetický. GET /api/suppliers/supplier-parts/catalog a GET /api/suppliers/supplier-parts/availability. Identita supplier-parts; SKU DEMO-SKU-006 až DEMO-SKU-010 dle aktuálního katalogu. Orientační doprava následující pracovní den; žádný skutečný partner nedostává e-mail ani objednávku.

## Rozhraní a pravomoci
supplier_allowed_actions=["catalog.read","availability.read","rfq_history.read"]
Agent smí číst katalog, sklad, nabídky a historii RFQ, doporučit řešení a eskalovat. V P0 nesmí vytvořit RFQ ani autonomně nakoupit díly. Zaměstnanec může připravit lokální draft RFQ. Jen majitel může potvrdit interní mock nákup označený simulated=true. Historie nákupů je fixture, nikoli důkaz současného oprávnění bota.

Primární služby využívají zákazníkovy pneumatiky. Nulový sklad nových pneumatik proto nezablokuje wheel_swap ani tyre_change, pokud je dostupný běžný spotřební materiál a kalendářová kapacita. Agent nesmí slibovat sklad ani ETA z dokumentu, když živý mock zdroj říká něco jiného.
