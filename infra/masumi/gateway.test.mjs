import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGateway } from './gateway.mjs';

const sellerKey = 'seller-application-test-key';
const buyerKey = 'buyer-application-test-key';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function setup(t, handler, options = {}) {
  const seen = [];
  const makeUpstream = side => createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ side, path: request.url, method: request.method,
      headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (handler) handler(request, response);
    else {
      response.setHeader('x-private-upstream', 'do-not-forward');
      response.end(JSON.stringify({ side }));
    }
  });
  const seller = makeUpstream('seller');
  const buyer = makeUpstream('buyer');
  const sellerPort = await listen(seller);
  const buyerPort = await listen(buyer);
  const gateway = createGateway({ sellerKey, buyerKey, sellerPort, buyerPort, ...options });
  const port = await listen(gateway);
  t.after(async () => {
    await Promise.all([gateway, seller, buyer].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  return { seen, url: `http://127.0.0.1:${port}` };
}

test('health is public, side keys are required, and administrative paths never reach upstream', async t => {
  const { url, seen } = await setup(t);
  assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true });
  for (const [path, key, status] of [
    ['/seller/api/v1/payment', undefined, 401],
    ['/seller/api/v1/payment', buyerKey, 401],
    ['/buyer/api/v1/utxos', sellerKey, 401],
    ['/seller/api/v1/wallet', sellerKey, 404],
    ['/seller/api/v1/registry', sellerKey, 404],
    ['/seller/api/v1/api-key', sellerKey, 404],
    ['/buyer/api/v1/payment', buyerKey, 404],
    ['/api/v1/payment', sellerKey, 404],
  ]) {
    const response = await fetch(`${url}${path}`, { headers: key ? { token: key } : {} });
    assert.equal(response.status, status, path);
  }
  const wrongMethod = await fetch(`${url}/seller/api/v1/payment`, {
    method: 'DELETE', headers: { token: sellerKey },
  });
  assert.equal(wrongMethod.status, 404);
  assert.equal(seen.length, 0);
});

test('authenticated requests use fixed side upstreams and preserve query and JSON body', async t => {
  const { url, seen } = await setup(t);
  const body = '{"network":"Preprod","input":"a+b"}';
  const response = await fetch(`${url}/seller/api/v1/payment/submit-result/?id=a%2Fb&value=a+b`, {
    method: 'POST', body, headers: { token: sellerKey, authorization: 'do-not-forward' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { side: 'seller' });
  assert.equal(response.headers.get('x-private-upstream'), null);
  assert.deepEqual({ side: seen[0].side, path: seen[0].path, method: seen[0].method, body: seen[0].body }, {
    side: 'seller', path: '/api/v1/payment/submit-result?id=a%2Fb&value=a+b', method: 'POST', body,
  });
  assert.equal(seen[0].headers.token, sellerKey);
  assert.equal(seen[0].headers.authorization, undefined);
  const buyerResponse = await fetch(`${url}/buyer/api/v1/utxos/?network=Preprod`, { headers: { token: buyerKey } });
  assert.deepEqual(await buyerResponse.json(), { side: 'buyer' });
  assert.equal(seen[1].path, '/api/v1/utxos?network=Preprod');
  assert.equal(seen[1].headers.token, buyerKey);
});

test('bodies above 64 KiB are rejected before forwarding', async t => {
  const { url, seen } = await setup(t);
  const response = await fetch(`${url}/buyer/api/v1/purchase`, {
    method: 'POST', headers: { token: buyerKey }, body: 'x'.repeat(64 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(seen.length, 0);
});

test('only the explicit method and endpoint pairs are forwarded', async t => {
  const { url, seen } = await setup(t);
  for (const [side, key, method, paths] of [
    ['seller', sellerKey, 'GET', ['/payment']],
    ['seller', sellerKey, 'POST', ['/payment', '/payment/resolve-blockchain-identifier',
      '/payment/submit-result', '/payment/authorize-refund']],
    ['buyer', buyerKey, 'GET', ['/payment-source', '/utxos']],
    ['buyer', buyerKey, 'POST', ['/purchase', '/purchase/resolve-blockchain-identifier',
      '/purchase/request-refund']],
  ]) {
    for (const path of paths) {
      const response = await fetch(`${url}/${side}/api/v1${path}`, { method, headers: { token: key } });
      assert.equal(response.status, 200, `${side} ${method} ${path}`);
      await response.json();
    }
  }
  assert.equal(seen.length, 10);
  for (const path of ['/wallet', '/api-key', '/registry', '/payment/submit-result/extra', '/payment//']) {
    const response = await fetch(`${url}/seller/api/v1${path}`, { method: 'POST', headers: { token: sellerKey } });
    assert.equal(response.status, 404, path);
  }
  assert.equal(seen.length, 10);
});

test('upstream redirects and errors reveal neither body nor headers', async t => {
  const { url, seen } = await setup(t, (request, response) => {
    response.writeHead(request.url.includes('redirect') ? 302 : 500, {
      location: 'http://127.0.0.1/private', 'x-upstream-secret': 'private-token',
    });
    response.end('private-diagnostic-content');
  });
  for (const [query, expected] of [['redirect', 502], ['error', 500]]) {
    const response = await fetch(`${url}/buyer/api/v1/utxos?${query}`, { headers: { token: buyerKey } });
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), { error: 'Request failed' });
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('x-upstream-secret'), null);
  }
  assert.equal(seen.length, 2);
});

test('upstream requests have a bounded deadline', async t => {
  const { url } = await setup(t, () => {}, { timeoutMs: 30 });
  const response = await fetch(`${url}/seller/api/v1/payment`, { headers: { token: sellerKey } });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'Request failed' });
});
