import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/handoru.js', import.meta.url), 'utf8');
function authInputs(mode: 'login' | 'signup') {
  const main = { innerHTML: '', addEventListener() {}, setAttribute() {} };
  const context = vm.createContext({
    document: { querySelector: () => main, addEventListener() {} },
    location: { search: '', origin: 'https://handle.example' }, URL, URLSearchParams,
    // Rendering is tested without a real session, network request or account creation.
    fetch: () => new Promise(() => {}),
  });
  // The module bootstrap loads a session; this seam renders only the real form.
  vm.runInContext(script.replace(/\nawait load\(\);\s*$/, '\n'), context);
  vm.runInContext(`state.authMode = '${mode}'; renderAuth();`, context);
  return [...main.innerHTML.matchAll(/<input\b([^>]+)>/g)].map(match => Object.fromEntries(
    [...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!]),
  ));
}

test('owner signup distinguishes the activation code from a confirmation password', () => {
  const inputs = authInputs('signup');
  const passwords = inputs.filter(input => input.type === 'password');
  assert.equal(passwords.length, 1, 'Safari must see only the actual new-password field');
  assert.equal(passwords[0]!.name, 'password');
  assert.equal(passwords[0]!.autocomplete, 'new-password');
  const activation = inputs.find(input => input.name === 'setup_secret')!;
  assert.equal(activation.type, 'text');
  assert.equal(activation.autocomplete, 'one-time-code');
  assert.equal(activation.autocapitalize, 'none');
  assert.equal(activation.spellcheck, 'false');
});

test('ordinary owner login keeps password autofill and has no activation field', () => {
  const inputs = authInputs('login');
  assert.equal(inputs.filter(input => input.type === 'password').length, 1);
  assert.equal(inputs.find(input => input.name === 'password')!.autocomplete, 'current-password');
  assert.ok(!inputs.some(input => input.name === 'setup_secret'));
});
