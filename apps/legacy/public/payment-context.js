/** Stored payments retain their own environment when the runtime configuration changes. */
export function paymentContext(runtime, payment) {
  const recorded = payment !== null && payment !== undefined;
  const source = recorded ? payment : runtime;
  const provider = source?.provider, network = source?.network;
  if (provider === 'local_demo') return { provider, network, simulation: true, onChain: false, recorded,
    label: 'Lokální simulace', description: 'Tento záznam vzniká bez blockchainové transakce.' };
  if (provider === 'masumi' && network === 'Preprod') return { provider, network, simulation: false, onChain: true, recorded,
    label: 'Masumi · Cardano Preprod', description: 'Masumi zpracovává transakce na síti Cardano Preprod v test-ADA. Korunová cena služby a síťová částka jsou samostatné údaje.' };
  if (provider === 'legacy_import') return { provider, network, simulation: false, onChain: false, recorded,
    label: 'Importovaná evidence', description: 'Záznam převzatý z původního systému neprokazuje současný stav u platebního poskytovatele.' };
  return { provider, network, simulation: false, onChain: false, recorded,
    label: 'Platební prostředí není ověřené', description: 'Z dostupných údajů nelze určit režim této platby.' };
}
