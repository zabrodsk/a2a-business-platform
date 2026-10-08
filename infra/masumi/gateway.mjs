import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const routes = {
  seller: new Set([
    'GET /payment', 'POST /payment', 'POST /payment/resolve-blockchain-identifier',
    'POST /payment/submit-result', 'POST /payment/authorize-refund',
  ]),
  buyer: new Set([
    'GET /payment-source', 'GET /utxos', 'POST /purchase',
    'POST /purchase/resolve-blockchain-identifier', 'POST /purchase/request-refund',
  ]),
};

function matchesKey(supplied, expected) {
  if (typeof supplied !== 'string' || !expected) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

function errorResponse(response, status) {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Request failed' }));
}

export function createGateway({ sellerKey, buyerKey, sellerPort = 3001, buyerPort = 3002,
  timeoutMs = 10_000, maxBodyBytes = 64 * 1024 }) {
  if (!sellerKey || !buyerKey || sellerKey === buyerKey) {
    throw new Error('Distinct seller and buyer application keys are required');
  }
  const sides = {
    seller: { key: sellerKey, port: sellerPort },
    buyer: { key: buyerKey, port: buyerPort },
  };
  const server = createServer(async (incoming, outgoing) => {
    const [pathname] = (incoming.url ?? '').split('?');
    if (incoming.method === 'GET' && pathname === '/healthz') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end('{"ok":true}');
      return;
    }
    const match = /^\/(seller|buyer)\/api\/v1(\/[^?]*)$/.exec(pathname);
    if (!match) {
      incoming.resume();
      errorResponse(outgoing, 404);
      return;
    }
    const [, side, rawPath] = match;
    const target = sides[side];
    if (!matchesKey(incoming.headers.token, target.key)) {
      incoming.resume();
      errorResponse(outgoing, 401);
      return;
    }
    const path = rawPath.replace(/\/$/, '');
    if (!routes[side].has(`${incoming.method} ${path}`)) {
      incoming.resume();
      errorResponse(outgoing, 404);
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          errorResponse(outgoing, 413);
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      errorResponse(outgoing, 400);
      return;
    }
    const queryIndex = incoming.url.indexOf('?');
    const query = queryIndex < 0 ? '' : incoming.url.slice(queryIndex);
    const body = Buffer.concat(chunks);
    const upstream = request({
      hostname: '127.0.0.1', port: target.port,
      path: `/api/v1${path}${query}`, method: incoming.method,
      headers: { token: target.key, 'content-type': 'application/json', 'content-length': body.length },
    });
    const timer = setTimeout(() => {
      errorResponse(outgoing, 504);
      upstream.destroy();
    }, timeoutMs);
    outgoing.on('close', () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    upstream.on('error', () => {
      clearTimeout(timer);
      errorResponse(outgoing, 502);
    });
    upstream.on('response', response => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        clearTimeout(timer);
        response.resume();
        errorResponse(outgoing, status >= 400 && status <= 599 ? status : 502);
        return;
      }
      const result = [];
      response.on('data', chunk => result.push(chunk));
      response.on('error', () => {
        clearTimeout(timer);
        errorResponse(outgoing, 502);
      });
      response.on('end', () => {
        clearTimeout(timer);
        if (outgoing.writableEnded) return;
        outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        outgoing.end(Buffer.concat(result));
      });
    });
    upstream.end(body);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

function applicationKey(side) {
  const contents = readFileSync(new URL(`./${side}.env`, import.meta.url), 'utf8');
  const value = /^PNEU007_APP_API_KEY=(.*)$/m.exec(contents)?.[1].trim();
  return value?.replace(/^(['"])(.*)\1$/, '$2');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.MASUMI_GATEWAY_PORT ?? 8811);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createGateway({ sellerKey: applicationKey('seller'), buyerKey: applicationKey('buyer') });
    server.on('error', () => {
      console.error('Masumi gateway failed to listen');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Masumi gateway listening on 127.0.0.1:${port}`));
  } catch {
    console.error('Masumi gateway configuration is invalid');
    process.exitCode = 1;
  }
}
