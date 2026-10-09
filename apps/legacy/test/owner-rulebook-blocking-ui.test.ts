import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/handoru.js', import.meta.url), 'utf8');
type Lang = 'cs' | 'en';
function fixture() {
  const questions = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, question: `Owner question ${i}`, critical: true }));
  return {
    id: 'pneu007', approvals: [],
    reports: [{ version: 2, questions, findings: [] as object[] }, { version: 3, findings: [{ severity: 'critical', description: 'Unrelated newer report finding' }] as object[] }],
    answers: questions.map(q => ({ report_version: 2, question_id: q.id, answer: 'Demo owner decision' })),
    rulebooks: [{ version: 12, status: 'proposed', payload_hash: 'hash12', params: { provider: 'masumi', network: 'Preprod', deposit_minor: 50000 }, findings: [] as object[], governance: { report_version: 2, blocked_parameters: ['provider', 'network', 'deposit_minor'] } }],
  };
}
function render(b: ReturnType<typeof fixture>, lang: Lang) {
  const element = { innerHTML: '', addEventListener() {}, setAttribute() {} };
  const context = vm.createContext({
    document: { querySelector: () => element, addEventListener() {} },
    location: { search: '', origin: 'https://handle.example' }, URL, URLSearchParams,
    fetch: () => new Promise(() => {}), fixture: b, lang,
  });
  vm.runInContext(script.replace(/\nawait load\(\);\s*$/, '\n'), context);
  return vm.runInContext('state.lang = lang; renderRules(fixture);', context) as string;
}
function activationDisabled(html: string) {
  const form = html.match(/<form\b[^>]*data-form="activate"[\s\S]*?<\/form>/)![0];
  return /<button\b[^>]*\bdisabled(?:\s|>)/.test(form);
}
for (const lang of ['cs', 'en'] as const) {
  test(`${lang}: all eight questions answered shows critical Masumi finding from exact source report`, () => {
    const b = fixture();
    b.reports[0]!.findings.push({ id: 'masumi-checkout-blocked-until-verification', severity: 'critical', description: 'Masumi Preprod checkout is not verified.', recommendation: 'Verify the checkout and submit a corrected audit and proposal.' });
    const html = render(b, lang);
    assert.equal(activationDisabled(html), true);
    assert.ok(html.includes('Masumi Preprod checkout is not verified.'));
    assert.ok(html.includes('Verify the checkout and submit a corrected audit and proposal.'));
    assert.ok(html.includes(lang === 'cs' ? 'Kritická zjištění' : 'Critical findings'));
    assert.ok(!html.includes(lang === 'cs' ? 'nezodpovězen' : 'unanswered'));
    assert.ok(!html.includes('Unrelated newer report finding'));
  });
  test(`${lang}: actual unanswered critical questions are named`, () => {
    const b = fixture();
    b.answers.shift();
    b.rulebooks[0]!.governance.blocked_parameters = [];
    const html = render(b, lang);
    assert.equal(activationDisabled(html), true);
    assert.ok(html.includes('Owner question 0'));
    assert.ok(!html.includes('Owner question 1'));
    assert.ok(html.includes(lang === 'cs' ? 'Odpovězte v Auditu' : 'Answer under Audit'));
  });
  test(`${lang}: blocked parameters without a finding get an honest fallback`, () => {
    const html = render(fixture(), lang);
    assert.equal(activationDisabled(html), true);
    assert.ok(html.includes(lang === 'cs' ? 'Návrh má blokované parametry' : 'The proposal has blocked parameters'));
    assert.ok(!html.includes(lang === 'cs' ? 'nezodpovězen' : 'unanswered'));
  });
  test(`${lang}: no recorded blockers leaves approval available`, () => {
    const b = fixture();
    b.rulebooks[0]!.governance.blocked_parameters = [];
    const html = render(b, lang);
    assert.equal(activationDisabled(html), false);
    assert.ok(!html.includes('hd-note-warn'));
  });
  test(`${lang}: rule findings and all untrusted blocker content are escaped`, () => {
    const b = fixture();
    b.answers.shift();
    b.reports[0]!.questions![0]!.question = '<img src=x onerror="alert(1)">';
    b.rulebooks[0]!.findings.push({ severity: 'critical', description: '<script>unsafe()</script>', recommendation: '<b>verify & retry</b>' });
    b.rulebooks[0]!.governance.blocked_parameters = ['<iframe>'];
    const html = render(b, lang);
    assert.equal(activationDisabled(html), true);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
    assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;verify &amp; retry&lt;/b&gt;'));
    assert.ok(html.includes('&lt;iframe&gt;'));
    assert.ok(!/<(?:script|img|iframe|b)>/.test(html));
  });
}
