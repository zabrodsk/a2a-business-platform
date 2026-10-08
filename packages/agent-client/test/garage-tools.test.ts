import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { garageMain } from '../src/garage-cli.js';
import { GARAGE_TOOLS } from '../src/garage-tools.js';

const token = 'private-test-token';
type Request = { method: string; url: string; authorization: string | undefined; body: string };

async function fixture(run: (context: {
  requests: Request[];
  invoke: (args: string[]) => Promise<string>;
  payload: (value: unknown) => Promise<string>;
  respond: (handler: (response: ServerResponse) => void) => void;
  origin: string;
}) => Promise<void>) {
  const requests: Request[] = [];
  let handler = (response: ServerResponse) => { response.end(JSON.stringify({ ok: true })); };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
    handler(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'garage-tools-'));
  let fileNumber = 0;
  try {
    await run({
      requests, origin,
      respond: next => { handler = next; },
      payload: async value => { const path = join(directory, `${fileNumber++}.json`); await writeFile(path, JSON.stringify(value)); return path; },
      invoke: args => capture(() => garageMain(['--url', origin, '--allow-http-localhost', ...args], { PNEU007_TOOL_TOKEN: token })),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await run(); return output; } finally { process.stdout.write = original; }
}

test('tools lists the local manifest without a URL or credentials', async () => {
  const output = await capture(() => garageMain(['tools'], {}));
  assert.deepEqual(JSON.parse(output), { tools: GARAGE_TOOLS });
  assert.equal(GARAGE_TOOLS.find(tool => tool.name === 'checkout')!.read_only, false);
  assert.ok(GARAGE_TOOLS.every(tool => !/admin|reschedule|cancel$/.test(tool.name)));
});

test('named commands send the correct authenticated methods, paths and payloads', async () => {
  await fixture(async ({ invoke, payload, requests }) => {
    const file = await payload({ service_id: 'wheel_swap' });
    for (const tool of GARAGE_TOOLS) {
      const args = [tool.name];
      if (tool.arguments.some(argument => argument.location === 'path')) args.push('fixture_1');
      const hasPayload = tool.arguments.some(argument => argument.location === 'file');
      if (hasPayload) args.push('--data-file', file);
      if (tool.name === 'masumi-status') args.push('--job', 'job_1');
      assert.deepEqual(JSON.parse(await invoke(args)), { ok: true });
      const request = requests.at(-1)!;
      assert.equal(request.method, tool.method);
      assert.equal(request.url, tool.path.replace(':id', 'fixture_1') + (tool.name === 'masumi-status' ? '?job_id=job_1' : ''));
      assert.equal(request.authorization, `Bearer ${token}`);
      assert.equal(request.body, hasPayload ? '{"service_id":"wheel_swap"}' : '');
    }
  });
});

test('agent payment commands expose discovery and seller jobs without node credentials', async () => {
  await fixture(async ({ invoke, requests, payload }) => {
    await invoke(['payments']);
    assert.equal(requests.at(-1)!.url, '/api/payments/config');
    await invoke(['masumi-availability']);
    assert.equal(requests.at(-1)!.url, '/masumi/availability');
    await invoke(['masumi-schema']);
    assert.equal(requests.at(-1)!.url, '/masumi/input_schema');
    const file = await payload({ input_data: { order_id: 'order-1' }, identifier_from_purchaser: '0123456789abcdef' });
    await invoke(['masumi-start', '--data-file', file]);
    assert.equal(requests.at(-1)!.method, 'POST');
    assert.equal(requests.at(-1)!.url, '/masumi/start_job');
    await invoke(['masumi-status', '--job', 'job&other=1']);
    assert.equal(requests.at(-1)!.url, '/masumi/status?job_id=job%26other%3D1');
    assert.equal(GARAGE_TOOLS.find(tool => tool.name === 'masumi-start')!.read_only, false);
    const before = requests.length;
    await assert.rejects(invoke(['masumi-status']), /requires --job/);
    assert.equal(requests.length, before);
  });
});

test('query filters are encoded and never become additional parameters', async () => {
  await fixture(async ({ invoke, requests }) => {
    await invoke(['availability', '--service', 'wheel swap&status=cancelled', '--from', '2026-10-09T10:00:00+02:00', '--to', '2026-10-10']);
    const target = new URL(requests.at(-1)!.url, 'https://garage.example');
    assert.equal(target.pathname, '/api/agent/availability');
    assert.equal(target.searchParams.get('service_id'), 'wheel swap&status=cancelled');
    assert.equal(target.searchParams.get('from'), '2026-10-09T10:00:00+02:00');
    assert.equal(target.searchParams.get('to'), '2026-10-10');
    assert.equal(target.searchParams.has('status'), false);
    await invoke(['reservations', '--from', '2026-10-09', '--to', '2026-10-10', '--status', 'confirmed']);
    assert.equal(requests.at(-1)!.url, '/api/agent/reservations?from=2026-10-09&to=2026-10-10&status=confirmed');
  });
});

test('invalid commands, IDs, flags and request objects fail before networking', async () => {
  await fixture(async ({ invoke, requests, payload }) => {
    const array = await payload([]), nullFile = await payload(null);
    for (const args of [
      ['unknown'], ['profile', 'extra'], ['quote', 'case-1'], ['price'],
      ['case', '../secret'], ['source', '%2e%2e'], ['order', 'a?b=c'], ['order', '.'], ['order', ''],
      ['profile', '--from', '2026-10-09'], ['profile', '--unknown'],
      ['availability', '--from'], ['availability', '--from', 'a', '--from', 'b'],
      ['reservations', '--status', 'pending'], ['checkout', 'order-1', '--data-file', array],
      ['price', '--data-file', array], ['price', '--data-file', nullFile],
      ['call', 'GET', '/api/services', '--data-file', array], ['call', 'GET', '/api/services', '--status', 'confirmed'],
    ]) await assert.rejects(invoke(args), /.+/, args.join(' '));
    assert.equal(requests.length, 0);
  });
});

test('generic call and datafile alias remain supported', async () => {
  await fixture(async ({ invoke, requests, payload }) => {
    const file = await payload({ hello: 'world' });
    await invoke(['call', 'post', '/api/example?mode=demo', '--datafile', file]);
    assert.deepEqual(requests[0], { method: 'POST', url: '/api/example?mode=demo', authorization: `Bearer ${token}`, body: '{"hello":"world"}' });
    await invoke(['price', '--datafile', file]);
    assert.equal(requests[1]!.url, '/api/pricing/calculate');
  });
});

test('HTTP denial is reported and credentials are redacted from successes and errors', async () => {
  await fixture(async ({ invoke, respond }) => {
    respond(response => { response.statusCode = 403; response.end(JSON.stringify({ error: `wrong role ${token}` })); });
    await assert.rejects(invoke(['cases']), error => {
      assert.match(String(error), /HTTP 403/);
      assert.match(String(error), /wrong role \[REDACTED\]/);
      assert.ok(!String(error).includes(token));
      return true;
    });
    respond(response => { response.end(JSON.stringify({ repeated: `${token} ${token}` })); });
    assert.equal(await invoke(['profile']), '{"repeated":"[REDACTED] [REDACTED]"}\n');
  });
});

test('redirects are not followed, including within the configured origin', async () => {
  await fixture(async ({ invoke, respond, requests, origin }) => {
    respond(response => { response.statusCode = 302; response.setHeader('location', `${origin}/leak`); response.end(); });
    await assert.rejects(invoke(['profile']));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, '/api/agent/profile');
  });
});

test('HTTPS, origin validation, token presence and generic path restrictions remain enforced', async () => {
  await fixture(async ({ origin, requests }) => {
    for (const args of [
      ['--url', origin, 'profile'],
      ['--url', 'http://example.com', '--allow-http-localhost', 'profile'],
      ['--url', `${origin}/prefix`, '--allow-http-localhost', 'profile'],
      ['--url', 'https://name:password@example.com', 'profile'],
      ['--url', 'https://example.com?x=1', 'profile'],
      ['--url', 'https://example.com#fragment', 'profile'],
      ['--url', origin, '--allow-http-localhost', 'call', 'GET', '//example.com'],
      ['--url', origin, '--allow-http-localhost', 'call', 'GET', '/\\example.com'],
      ['--url', origin, '--allow-http-localhost', 'call', 'GET', '/api/path#fragment'],
    ]) await assert.rejects(garageMain(args, { PNEU007_TOOL_TOKEN: token }));
    await assert.rejects(garageMain(['--url', origin, '--allow-http-localhost', 'profile'], {}), /TOKEN is required/);
    await assert.rejects(garageMain(['--url', origin, '--allow-http-localhost', 'profile'], { PNEU007_TOOL_TOKEN: 'bad\nheader' }), /TOKEN is required/);
    assert.equal(requests.length, 0);
  });
});

test('the CLI redacts credentials in local input errors and exits unsuccessfully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garage-cli-error-'));
  const file = join(directory, 'invalid.json');
  try {
    await writeFile(file, `{"secret":"${token}", broken}`);
    const cli = fileURLToPath(new URL('../src/garage-cli.ts', import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', cli, '--url', 'https://garage.example', 'price', '--data-file', file], { env: { ...process.env, PNEU007_TOOL_TOKEN: token } }), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.ok(failure.stderr.length > 0);
      assert.ok(!failure.stderr.includes(token));
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
