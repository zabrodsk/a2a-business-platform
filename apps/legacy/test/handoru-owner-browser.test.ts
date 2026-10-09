// Real headless browser against synthetic local fixtures; not proof of an actual GrokBot runtime.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { freshFixture, json, clock, password, type FreshFixture } from './handoru-fixture.js';

const chromePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
const screenshotDir = process.env.HANDORU_BROWSER_SCREENSHOT_DIR || resolve(import.meta.dirname, '../../../.omx/state/ownership-verification/screenshots');
const missingChrome = 'Headless Chrome unavailable at supported executable paths; no personal browser session is used.';

type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
async function browser(t: TestContext) {
  assert.ok(chromePath);
  const profile = mkdtempSync(join(tmpdir(), 'handle-synthetic-browser-'));
  const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  const pending = new Map<number, Pending>();
  t.after(async () => {
    socket?.close();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed')); }
    pending.clear();
    await stop(child);
    rmSync(profile, { recursive: true, force: true });
  });
  let port = '';
  const deadline = Date.now() + 10000;
  while (!port && Date.now() < deadline) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]!; } catch { await delay(50); }
    if (child.exitCode !== null) throw new Error('Headless Chrome exited before opening DevTools');
  }
  assert.ok(port, 'Headless Chrome must open its isolated DevTools port');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  const target = await response.json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`DevTools timeout: ${method}`)); }, 10000);
    pending.set(next, { resolve, reject, timer });
    socket!.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.text || 'Browser evaluation failed');
    return result.result.value as T;
  };
  const waitFor = async (expression: string, message: string) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) { if (await evaluate<boolean>(expression)) return; await delay(50); }
    assert.fail(message);
  };
  const fill = (selector: string, value: string) => evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input) throw new Error('Required input missing'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async (name: string) => {
    mkdirSync(screenshotDir, { recursive: true });
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const path = join(screenshotDir, name);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    t.diagnostic(`Synthetic browser screenshot: ${path}`);
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${clock().getTime()};` });
  return { send, evaluate, waitFor, fill, click, screenshot };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited; clearTimeout(timeout);
}
async function registered(t: TestContext) {
  const fixture = await freshFixture(t);
  await fixture.signup(); // Existing independent Handle owner; browser still has no session.
  const registration = await json(await fixture.publicCall('/api/handle/v1/agent-registrations', {
    runtime: 'Synthetic headless browser fixture, not actual GrokBot', legacy_url: fixture.base,
  }), 201);
  return { fixture, registration };
}
async function login(page: Awaited<ReturnType<typeof browser>>, f: FreshFixture, requestId: string) {
  await page.send('Page.navigate', { url: `${f.base}/handle?request=${encodeURIComponent(requestId)}` });
  await page.waitFor(`!!document.querySelector('form[data-form="login"]')`, 'Independent Handle login must render');
  await page.fill('[name="email"]', 'owner@example.test');
  await page.fill('[name="password"]', password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitFor(`!!document.querySelector('form[data-form="consent"]')`, 'Existing human login must show the request');
}
const approve = 'form[data-form="consent"] button[value="approved"]';

test('synthetic Chrome owner completes website verification before separately approving the connection (not actual GrokBot)', { skip: chromePath ? false : missingChrome, timeout: 40000 }, async t => {
  const { fixture: f, registration } = await registered(t);
  const page = await browser(t);
  await login(page, f, registration.request_id);
  await page.screenshot('synthetic-before-website-proof.png');
  assert.equal(await page.evaluate(`document.querySelector('${approve}').disabled`), true, 'Missing website proof must disable approval before the human submits');
  assert.equal((await f.publicCall('/.well-known/handle-ownership.json')).status, 404, 'Handle login must not become legacy website proof');
  await page.click(`[data-action="verify-website"][data-request="${registration.request_id}"]`);
  await page.waitFor(`!!document.querySelector('dialog[open] [name="legacy_password"]')`, 'Website verification must request a separate native legacy login');
  await page.fill('dialog[open] [name="legacy_username"]', 'owner');
  await page.fill('dialog[open] [name="legacy_password"]', password);
  await page.click('dialog[open] [name="publish_allowed"]');
  await page.screenshot('synthetic-website-verification-dialog.png');
  await page.click('dialog[open] button[type="submit"]');
  await page.waitFor(`!document.querySelector('dialog[open]') && !document.querySelector('${approve}').disabled`, 'Publicly verified exact challenge must close the dialog and enable consent');
  const proof = await json(await f.publicCall('/.well-known/handle-ownership.json'));
  assert.equal(proof.challenge, registration.ownership_challenge.challenge);
  const provisional = f.client({ authorization: `Bearer ${registration.provisional_credential}` });
  const statusPath = `/api/handle/v1/onboarding/${registration.request_id}`;
  assert.equal((await json(await provisional(statusPath))).state, 'pending', 'Website verification must never automatically pair the agent');
  await page.screenshot('synthetic-after-website-proof-before-consent.png');
  await page.fill('form[data-form="consent"] [name="user_code"]', registration.user_code);
  await page.click('form[data-form="consent"] [name="reviewed"]');
  await page.click(approve);
  await page.waitFor(`document.querySelector('#feedback')?.textContent.includes('Auditní připojení schváleno')`, 'Independent human consent must succeed after website verification');
  assert.equal((await json(await provisional(statusPath))).state, 'approved');
  await page.screenshot('synthetic-after-independent-consent.png');
  const credential = await json(await provisional(`${statusPath}/credentials`, {}));
  assert.ok(credential.access_token, 'The bot can continue credential exchange without another instruction');
});

test('synthetic Chrome wrong legacy login clears the password and keeps website proof and connection approval blocked', { skip: chromePath ? false : missingChrome, timeout: 40000 }, async t => {
  const { fixture: f, registration } = await registered(t);
  const page = await browser(t);
  await login(page, f, registration.request_id);
  assert.equal(await page.evaluate(`document.querySelector('${approve}').disabled`), true);
  await page.click(`[data-action="verify-website"][data-request="${registration.request_id}"]`);
  await page.waitFor(`!!document.querySelector('dialog[open] [name="legacy_password"]')`, 'Separate legacy login must render');
  await page.fill('dialog[open] [name="legacy_username"]', 'owner');
  await page.fill('dialog[open] [name="legacy_password"]', 'synthetic-wrong-password');
  await page.click('dialog[open] [name="publish_allowed"]');
  await page.click('dialog[open] button[type="submit"]');
  await page.waitFor(`document.querySelector('dialog[open] [name="legacy_password"]')?.value === '' && document.querySelector('dialog[open] button[type="submit"]')?.disabled === false`, 'Failed login must clear the password and allow a new attempt');
  assert.equal(await page.evaluate(`document.querySelector('${approve}').disabled`), true);
  assert.equal((await f.publicCall('/.well-known/handle-ownership.json')).status, 404);
  const provisional = f.client({ authorization: `Bearer ${registration.provisional_credential}` });
  const status = await json(await provisional(`/api/handle/v1/onboarding/${registration.request_id}`));
  assert.equal(status.state, 'pending');
  assert.equal(status.ownership_verification.ready_for_consent, false);
  assert.equal(f.handoru.installation(), undefined);
});
