export interface PaymentContext {
  provider: unknown; network: unknown; simulation: boolean; onChain: boolean; recorded: boolean;
  label: string; description: string;
}
export function paymentContext(runtime: unknown, payment?: unknown): PaymentContext;
