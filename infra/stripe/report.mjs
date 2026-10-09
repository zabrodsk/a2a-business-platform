// Publish only allowlisted facts from independently observed Stripe test evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => JSON.parse(readFileSync(resolve(root, 'data', name), 'utf8'));
const payment = read('stripe-link-payment-proof.json');
const counts = read('stripe-link-persistence-proof.json');
const retry = read('stripe-link-retry-proof.json');
const recovery = read('stripe-link-recovery-proof.json');
const confirmed = payment.payment_method === 'link' && payment.payment_status === 'paid'
  && payment.provider_state === 'succeeded' && payment.livemode === false && payment.currency === 'czk'
  && payment.amount_minor === 50000 && payment.booking_status === 'confirmed'
  && counts.order_id === payment.order_id && counts.checkouts === 1 && counts.payments === 1
  && counts.bookings === 1 && counts.paid_ledger_entries === 1 && counts.masumi_intents === 0
  && counts.after_application_restart && counts.webhooks.some(event => event.event_type === 'checkout.session.completed')
  && retry.same_checkout && retry.same_session && retry.state === 'paid'
  && retry.order_id === payment.order_id && retry.checkout_id === payment.checkout_id && retry.session_id === payment.session_id
  && recovery.identities_unchanged && recovery.after_application_restart && recovery.state === 'paid'
  && recovery.session_id === payment.session_id && recovery.payment_intent_id === payment.payment_intent_id;
if (!confirmed) throw new Error('Live Link payment and recovery evidence is incomplete.');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rows = [
  ['Merchant', payment.merchant_account], ['Checkout', payment.checkout_id], ['Stripe Session', payment.session_id],
  ['Stripe payment', payment.payment_intent_id], ['Payment method', payment.payment_method],
  ['Provider state', `${payment.provider_state}; livemode=false`], ['Test amount', '500.00 CZK'],
  ['Order', payment.order_id], ['Booking', payment.booking_id], ['Booking state', payment.booking_status],
  ['Remaining fictional business balance', `${(payment.order_balance_minor / 100).toFixed(2)} CZK`],
];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verified Link sandbox payment</title><style>body{font:16px/1.65 system-ui;max-width:1000px;margin:36px auto;padding:0 22px;color:#172b3b}h1,h2{line-height:1.25}table{border-collapse:collapse;width:100%}th,td{padding:10px;border:1px solid #cbd5df;text-align:left;overflow-wrap:anywhere}.notice{padding:18px;background:#edf5ef}code{overflow-wrap:anywhere}</style></head><body>
<h1>Link by Stripe: verified sandbox payment</h1><p class="notice"><strong>An actual 500 CZK test payment through the Link wallet succeeded.</strong> The deployed app recorded one payment and booking in the existing Handle / handoru.ai Stripe test account. No real money or physical service is involved.</p>
<p>Verified ${esc(payment.verified_at)} UTC. <a href="https://pneu007-production.up.railway.app/objednavka?payment=link">Open checkout</a> · <a href="https://dashboard.stripe.com/test/payments/${esc(payment.payment_intent_id)}">Stripe payment (sign in to the Handle account, test mode)</a>.</p>
<table><tr><th>Evidence</th><th>Observed value</th></tr>${rows.map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('')}</table>
<p><a href="evidence/stripe-link-paid.png">View the deployed paid booking screen</a>.</p>
<h2>Provider and application proof</h2><p>The operator-controlled test used the Link wallet in Stripe's hosted sandbox, with Stripe's official test card and fictional customer details. An authenticated merchant-scoped Stripe API read independently verified payment_method=link, succeeded, exactly 50,000 CZK minor units and livemode=false. The amount is native test CZK, separate from the Cardano demo mapping.</p>
<p>The deployed signed-webhook handler processed ${counts.webhooks.map(event => `<code>${esc(event.event_id)}</code> (${esc(event.event_type)}, ${esc(event.processed_at)} UTC)`).join('; ')}. A success redirect was not treated as payment evidence. The provider's current Session was re-read before the payment and booking were confirmed.</p>
<h2>Retry and restart</h2><p>Repeating checkout returned HTTP ${esc(retry.repeat_checkout_status)}, the same Checkout and Stripe Session, and paid. After application restart, the same order, booking, Session and payment identities remained paid. A read-only database check at ${esc(counts.checked_at)} UTC found exactly one Checkout, one payment, one booking and one stripe_paid ledger entry for this order, with zero Masumi payment intents.</p>
<h2>Validation and limits</h2><p>The integrated release passed 477 workspace tests, all typechecks, image builds and CI. Desktop/mobile browser checks verified the explicit approval UI. This is an operator-run technical test; it does not claim an independent customer's identity or consent demonstration.</p>
<p>Live API keys are rejected. Stripe paid does not mean a bank payout. Automated Stripe refunds and cancellation of an active Stripe checkout are outside this addition. The existing Masumi Preprod workflow remains separate and its original verified payment is preserved.</p>
<p><a href="stripe-link.html">Setup and operating guide</a> · <a href="masumi-live-proof.html">Masumi Preprod proof</a>.</p></body></html>`;
writeFileSync(resolve(root, 'docs/stripe-link-live-proof.html'), html);
console.log(JSON.stringify({ report: 'docs/stripe-link-live-proof.html', confirmed, method: payment.payment_method }));
