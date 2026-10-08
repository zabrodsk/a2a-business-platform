// Render public technical evidence from the private, observed Preprod records.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => JSON.parse(readFileSync(resolve(root, 'data', name), 'utf8'));
const smoke = read('masumi-live-smoke.json');
const registration = read('masumi-registration.json');
const funding = read('masumi-funding-proof.json');
const result = read('masumi-result-proof.json');
const recovery = read('masumi-recovery-proof.json');
const counts = read('masumi-persistence-counts.json');
const finalRecovery = existsSync(resolve(root, 'data/masumi-final-recovery-proof.json')) ? read('masumi-final-recovery-proof.json') : null;
const settlement = existsSync(resolve(root, 'data/masumi-settlement-proof.json')) ? read('masumi-settlement-proof.json') : null;
const observed = smoke.latest?.payment?.observation;
const completed = smoke.phase === 'seller_paid' && smoke.result_hash_verified && settlement?.confirmed
  && settlement.hash === observed?.transaction_hash && settlement.escrow_transaction === result.hash
  && observed?.raw?.settlement?.result_hash === smoke.expected_output_hash
  && observed?.raw?.settlement?.seller_net_lovelace === settlement.seller_net_increase_lovelace;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const link = hash => /^[a-f0-9]{64}$/.test(hash ?? '') ? `<a href="https://preprod.cardanoscan.io/transaction/${hash}">${hash}</a>` : 'Pending';
const local = time => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', dateStyle: 'long', timeStyle: 'short' }).format(new Date(time));
const unlock = Number(smoke.latest.payment.observation.raw.payment.unlockTime);
const automaticCollection = unlock + 10 * 60_000;
const rows = [
  ['Service registration', registration.state === 'RegistrationConfirmed' ? 'Confirmed' : registration.state, registration.CurrentTransaction?.txHash],
  ['Buyer funds held in escrow', 'Confirmed: 5 test-ADA', funding.hash],
  ['Reservation receipt recorded', smoke.result_hash_verified ? 'Confirmed; receipt hash matches' : 'Hash verification pending', result.hash],
  ['Seller collection', settlement?.confirmed ? (completed ? 'Confirmed; application seller_paid' : 'Confirmed on-chain; application reconciliation pending') : `Automatic collection expected after ${local(automaticCollection)} Prague time`, settlement?.hash],
];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Masumi live Preprod evidence</title>
<style>body{font:16px/1.65 system-ui;max-width:1050px;margin:36px auto;padding:0 22px;color:#172b3b}h1,h2{line-height:1.25}table{border-collapse:collapse;width:100%}th,td{padding:12px;border:1px solid #cbd5df;text-align:left;vertical-align:top}td a,code{overflow-wrap:anywhere;word-break:break-word}.notice{background:#edf5ef;padding:18px}code{font-family:ui-monospace,monospace}</style></head><body>
<h1>Masumi: live Preprod verification</h1><p class="notice"><strong>${completed ? 'End-to-end seller payment verified.' : settlement?.confirmed ? 'All payment transactions confirmed; application reconciliation pending.' : 'Escrow and result verified; seller collection pending.'}</strong> This uses free Cardano Preprod tokens with no monetary value and a fictional reservation.</p>
<p>Updated ${esc(local(Date.now()))}, Europe/Prague. Application: <a href="https://pneu007-production.up.railway.app">Pneu007</a>.</p>
<table><tr><th>Stage</th><th>Observed result</th><th>Cardano transaction</th></tr>${rows.map(([stage, status, hash]) => `<tr><td>${esc(stage)}</td><td>${esc(status)}</td><td>${link(hash)}</td></tr>`).join('')}</table>
<h2>Reservation and integrity</h2><p>Order: <code>${esc(smoke.order_id)}</code><br>Booking: <code>${esc(smoke.latest.booking.id)}</code><br>Receipt hash: <code>${esc(smoke.expected_output_hash)}</code></p>
<p>The digital receipt's purchaser-bound SHA-256 matches the result recorded on-chain. A confirmed reservation is the delivered digital result; physical tyre service remains fictional.</p>
<h2>Recovery and access checks</h2><p>The application and payment nodes were restarted after result submission. ${recovery.identities_unchanged ? 'Order, booking, intent, buyer/seller provider IDs and hashes remained unchanged.' : 'Identity verification is pending.'} The persistent application database contains ${counts.bookings} booking, ${counts.payments} payment and ${counts.intents} intent for this order. Another customer identity received HTTP 403 when requesting it.</p>
${finalRecovery?.state === 'seller_paid' && finalRecovery.identities_unchanged && finalRecovery.receipt_unchanged ? '<p>The application was restarted again after settlement. It retained seller_paid, the same order, booking, payment intent and withdrawal hash, with the receipt unchanged and no workflow error.</p>' : ''}
<h2>Test method and cost</h2><p>The driver used scripted customer/business agent API clients and an operator-controlled seeded customer session to approve a bounded test mandate. Independent GrokBot account interoperability remains a separate validation.</p>
<p>The registered deposit is 5 test-ADA. The additional 15 test-ADA amount shown at authorization is a maximum budget, not an actual fee. Observed transaction fees: buyer funding ${Number(funding.fees_lovelace) / 1000000} test-ADA; result submission ${Number(result.fees_lovelace) / 1000000} test-ADA.${settlement ? ` Seller collection fee: ${Number(settlement.fees_lovelace) / 1000000} test-ADA.` : ''} All are test tokens; CZK is a demo accounting mapping.</p>
${settlement ? `<p>The seller collection output is ${Number(settlement.gross_payout_lovelace) / 1000000} test-ADA. The protocol fee output is ${Number(settlement.protocol_fee_lovelace) / 1000000} test-ADA; its minimum output amount exceeds 5% for this small deposit. After the collection transaction fee, the seller wallet's net increase is ${Number(settlement.seller_net_increase_lovelace) / 1000000} test-ADA. Collateral and change are excluded from the payout calculation.</p>` : ''}
<p>Configuration inspection cannot verify blockchain transactions by itself. This report uses actual provider observations and separately retrieved confirmed Cardano transaction records. Live refund handling has not been tested in this run.</p>
<p><a href="masumi-operations.html">Operating guide</a> · <a href="masumi-setup.html">Detailed setup and official upstream fix</a></p></body></html>`;
writeFileSync(resolve(root, 'docs/masumi-live-proof.html'), html);
console.log(JSON.stringify({ report: 'docs/masumi-live-proof.html', phase: smoke.phase, completed: Boolean(completed) }));
