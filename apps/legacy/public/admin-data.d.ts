export type StatusTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';
export interface DisplayStatus { label: string; tone: StatusTone }
export interface OrderAction { action: 'reschedule' | 'cancel' | 'resume-payment' | 'authorize-refund' | 'refund-request'; label: string; kind?: 'danger' | 'secondary' }
export function orderOf(record: unknown): Record<string, unknown>;
export function orderStatus(record: unknown): DisplayStatus;
export function paymentStatus(record: unknown): DisplayStatus & { note: string };
export function shortReference(id: unknown): string;
export function serviceLabel(spec: unknown): string;
export function vehicleLabel(spec: unknown): string;
export function pragueDay(value?: unknown): string;
export function dayLabel(value: unknown): string;
export function timeLabel(value: unknown): string;
export function moneyLabel(minor: unknown): string;
export function matchesSearch(query: unknown, valuesArray: unknown): boolean;
export function availableOrderActions(record: unknown, role: unknown, now?: unknown): OrderAction[];
