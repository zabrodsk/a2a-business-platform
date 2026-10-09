import test from 'node:test';
import assert from 'node:assert/strict';
import { CANCELLATION_POLICY as policy, renderCancellationPolicy } from '../src/cancellation-policy.js';

test('a cancelled unperformed service returns the actual payment without adding an unpaid balance or a late penalty', () => {
  assert.equal(policy.cancellation.scope, 'unperformed_service');
  assert.equal(policy.cancellation.recommended_notice_is_condition, false);
  assert.deepEqual([
    policy.cancellation.change_fee_minor,
    policy.cancellation.cancellation_fee_minor,
    policy.cancellation.late_cancellation_fee_minor,
    policy.cancellation.no_show_fee_minor,
  ], [0, 0, 0, 0]);
  assert.deepEqual([
    policy.refund.unperformed_service_percent,
    policy.refund.late_cancellation_percent,
    policy.refund.no_show_percent,
    policy.cancellation.shop_cancellation_refund_percent,
  ], [100, 100, 100, 100]);
  assert.equal(policy.refund.amount_basis, 'verified_actual_paid_service_or_deposit_amount');
  assert.equal(policy.refund.include_unpaid_balance, false);
  assert.equal(policy.refund.include_spent_network_fees, false);
  assert.equal(policy.cancellation.effective_when, 'recorded_and_confirmed_by_staff');
  assert.equal(policy.cancellation.completed_service, 'not_cancellable_owner_reviews_complaint');
});

test('refund SLAs start after verification and commit human action rather than arrival of funds', () => {
  assert.equal(policy.refund.acknowledgement_business_days, 1);
  assert.equal(policy.refund.owner_action_business_days, 3);
  assert.deepEqual(policy.refund.owner_action_starts_after, ['cancellation_accepted', 'original_payment_verified']);
  assert.equal(policy.refund.owner_action, 'initiate_refund_or_arrange_manual_compensation');
  assert.equal(policy.refund.unconfirmed_refund_follow_up_business_days, 5);
  assert.equal(policy.refund.follow_up_starts_after, 'refund_initiation');
  assert.equal(policy.refund.deadline_kind, 'human_operating_service_level');
  assert.equal(policy.refund.funds_arrival_deadline_guaranteed, false);
  assert.deepEqual(policy.refund.business_calendar.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(policy.refund.business_calendar.timezone, 'Europe/Prague');
});

test('published terms do not grant agent authority or invent provider refund capabilities', () => {
  assert.equal(policy.authority.rulebook_activation, false);
  assert.equal(policy.implementation_notes.agent_refund_authority, false);
  assert.equal(policy.implementation_notes.automatic_deadline_scheduler, false);
  assert.equal(policy.implementation_notes.new_rulebook_requires_separate_human_approval, true);
  assert.equal(policy.payment_routes.masumi.technical_window_is_shop_cancellation_deadline, false);
  assert.equal(policy.payment_routes.masumi.test_asset_has_fiat_refund_value, false);
  assert.equal(policy.refund.fiat_conversion_for_test_assets, false);
  assert.equal(policy.payment_routes.stripe_link.automatic_refund_tracking_in_legacy, false);
  assert.match(policy.refund.unknown_original_payment, /reconcile_original_transaction.*no_duplicate_charge/);
  assert.deepEqual(policy.refund.completion_evidence_any_of, ['provider_confirmed_refund', 'verified_external_compensation_proof']);
  const serialized = JSON.stringify(policy);
  assert.doesNotMatch(serialized, /auto_discount|owner_approval_limit|hard_discount|secret|token/);
});

test('customer terms explain cancellation, human deadlines and provider limits without repeating simulation warnings', () => {
  const html = renderCancellationPolicy();
  assert.match(html, /^<section id="storno"/);
  assert.match(html, /zdarma/);
  assert.match(html, /24 hodin/);
  assert.match(html, /100 % skutečně zaplacené/);
  assert.match(html, /do 1 pracovního dne/);
  assert.match(html, /do 3 pracovních dnů zahájí/);
  assert.match(html, /do 5 pracovních dnů od jeho zahájení/);
  assert.match(html, /nikoli okamžik připsání/);
  assert.match(html, /<details[^>]*>/);
  assert.match(html, /unlockTime/);
  assert.match(html, /test-ADA, nikoli v korunách/);
  assert.match(html, /mimo automatický proces rezervace/);
  assert.match(html, /href="\/cancellation-policy.json"/);
  assert.ok(html.includes(policy.version));
  assert.doesNotMatch(html, /\[PLACEHOLDER|simulac|doplní provozovatel/);
});
