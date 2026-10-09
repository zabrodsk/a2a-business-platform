import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/handoru.js', import.meta.url), 'utf8');
function fixture() {
  return { id: 'pneu007', reports: [{ version: 2, questions: [{ id: 'payment-policy', question: 'Which payment mode?' }], findings: [] }],
    answers: [
      { version: 1, report_version: 2, question_id: 'payment-policy', answer: 'Old Masumi answer', kind: 'policy_decision', scope: 'Old scope' },
      { version: 5, report_version: 2, question_id: 'payment-policy', answer: 'Local <demo> & "only" </textarea><script>unsafe()</script>', kind: 'external_fact', scope: 'Pneu "demo" <only>', valid_until: '2027-10-09T12:34:56.789Z' },
      { version: 9, report_version: 1, question_id: 'payment-policy', answer: 'Other report answer', kind: 'policy_decision', scope: 'Wrong report' },
    ] };
}
function setup(b = fixture(), lang = 'en') {
  const element = { innerHTML: '', addEventListener() {}, setAttribute() {} };
  const listeners: Record<string, (event: unknown) => Promise<void>> = {};
  const context = vm.createContext({
    document: { querySelector: () => element, addEventListener: (event: string, callback: typeof listeners[string]) => { listeners[event] = callback; } },
    location: { search: '', origin: 'https://handle.example' }, URL, URLSearchParams,
    fetch: () => new Promise(() => {}), fixture: b, lang,
  });
  vm.runInContext(script.replace(/\nawait load\(\);\s*$/, '\n'), context);
  const html = vm.runInContext('state.lang = lang; state.businessId = fixture.id; state.dashboard.businesses = [fixture]; renderAudit(fixture);', context) as string;
  return { html, context, listeners };
}
for (const lang of ['cs', 'en']) {
  test(`${lang}: answered question has collapsed update form for latest answer, escaped values and exact target`, () => {
    const { html } = setup(fixture(), lang);
    const details = html.match(/<details class="hc-tech"><summary>(?:Update answer|Upravit odpověď)<\/summary>([\s\S]*?)<\/details>/);
    assert.ok(details, 'answered question must offer a collapsed update form');
    assert.ok(!details[0].includes('<details class="hc-tech" open'));
    assert.ok(details[1]!.includes('data-form="answer" data-version="2" data-question="payment-policy"'));
    assert.ok(details[1]!.includes('Local &lt;demo&gt; &amp; &quot;only&quot; &lt;/textarea&gt;&lt;script&gt;unsafe()&lt;/script&gt;'));
    assert.ok(details[1]!.includes('value="Pneu &quot;demo&quot; &lt;only&gt;"'));
    assert.match(details[1]!, /name="kind" value="external_fact" checked/);
    assert.doesNotMatch(details[1]!, /name="kind" value="policy_decision" checked/);
    assert.ok(!html.includes('Old Masumi answer'));
    assert.ok(!html.includes('Other report answer'));
    const expiry = details[1]!.match(/name="valid_until"[^>]*value="([^"]*)"/)![1]!;
    assert.equal(new Date(expiry).toISOString(), '2027-10-09T12:34:56.789Z', 'local date input must preserve the exact UTC instant');
  });
}
test('unanswered form retains empty answer, default owner policy and scope', () => {
  const b = fixture(); b.answers = [];
  const { html } = setup(b);
  assert.match(html, /<textarea[^>]*name="answer"[^>]*><\/textarea>/);
  assert.match(html, /name="kind" value="policy_decision" checked/);
  assert.ok(html.includes('value="Whole business, normal operation"'));
  assert.ok(!html.includes('<summary>Update answer</summary>'));
});
test('editing an answer without expiry does not invent an expiry', () => {
  const b = fixture(); b.answers = [b.answers[0]!];
  const { html } = setup(b);
  assert.match(html, /name="valid_until"[^>]*value=""/);
  assert.match(html, /name="kind" value="policy_decision" checked/);
});
test('updated answer uses the existing owner POST handler only on explicit submit', async () => {
  const { context, listeners } = setup();
  const requests: { path: string; body: Record<string, string> }[] = [];
  const values = { answer: 'Local simulation only. No Masumi or chain payment.', kind: 'policy_decision', scope: 'Demo only', valid_until: '2027-10-09T12:34:56.789' };
  context.requests = requests;
  context.FormData = class { get(key: keyof typeof values) { return values[key]; } };
  vm.runInContext('api = async (path, body) => { requests.push({path,body}); return {}; }; load = async () => {};', context);
  assert.equal(requests.length, 0, 'rendering never saves policy');
  const form = { dataset: { form: 'answer', version: '2', question: 'payment-policy' }, closest() { return this; }, querySelectorAll() { return []; } };
  await listeners.submit!({ target: form, preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, '/businesses/pneu007/owner/questions/2/payment-policy/answer');
  assert.equal(requests[0]!.body.answer, values.answer);
  assert.equal(requests[0]!.body.kind, values.kind);
  assert.equal(requests[0]!.body.scope, values.scope);
  assert.equal(requests[0]!.body.valid_until, new Date(values.valid_until).toISOString());
});
test('unchanged expiry preserves its original instant during the Prague DST overlap', async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'Europe/Prague';
  try {
    const b = fixture();
    b.answers[1]!.valid_until = '2027-10-31T01:30:00.789Z';
    const { html, context, listeners } = setup(b);
    const formHtml = html.match(/<form\b[^>]*data-form="answer"[\s\S]*?<\/form>/)![0];
    const expiry = formHtml.match(/name="valid_until"[^>]*value="([^"]*)"/)![1]!;
    const original = formHtml.match(/data-expiry-original="([^"]*)"/)![1]!;
    const displayed = formHtml.match(/data-expiry-local="([^"]*)"/)![1]!;
    assert.equal(expiry, '2027-10-31T02:30:00.789');
    assert.notEqual(new Date(expiry).toISOString(), original, 'fixture exercises the ambiguous fall-back hour');
    const requests: { path: string; body: Record<string, string> }[] = [];
    context.requests = requests;
    let currentExpiry = expiry;
    context.FormData = class { get(key: string) { return key === 'valid_until' ? currentExpiry : key === 'answer' ? 'Updated demo policy' : key === 'kind' ? 'policy_decision' : 'Demo'; } };
    vm.runInContext('api = async (path, body) => { requests.push({path,body}); return {}; }; load = async () => {};', context);
    const form = { dataset: { form: 'answer', version: '2', question: 'payment-policy', expiryOriginal: original, expiryLocal: displayed }, closest() { return this; }, querySelectorAll() { return []; } };
    await listeners.submit!({ target: form, preventDefault() {} });
    assert.equal(requests[0]!.body.valid_until, '2027-10-31T01:30:00.789Z');
    currentExpiry = '2027-10-31T04:30:00.789';
    await listeners.submit!({ target: form, preventDefault() {} });
    assert.equal(requests[1]!.body.valid_until, '2027-10-31T03:30:00.789Z', 'explicitly edited expiry uses the chosen local time');
    currentExpiry = '';
    await listeners.submit!({ target: form, preventDefault() {} });
    assert.ok(!('valid_until' in requests[2]!.body), 'clearing expiry stays optional');
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
