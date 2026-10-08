import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;

/** Deliberately conservative: only ordinary public unicast addresses are accepted. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 168) || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  // Only 2000::/3 global unicast; this also excludes mapped IPv4, NAT64,
  // loopback, unspecified, unique-local, link-local and multicast addresses.
  const [first, second = '0'] = address.toLowerCase().split(':');
  const high = parseInt(first, 16);
  const next = parseInt(second || '0', 16);
  return high >= 0x2000 && high <= 0x3fff
    && !(high === 0x2001 && (next < 0x0200 || next === 0x0db8))
    && high !== 0x2002 // 6to4 embeds another IP and is not a direct public target.
    && !(high === 0x3fff && next < 0x1000); // Documentation prefix.
}

export function assertPublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid public HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('#') || (url.port && url.port !== '443')) {
    throw new Error('A public HTTPS URL without credentials, fragment or custom port is required');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Private or reserved remote addresses are not allowed');
  } else if (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(hostname)) {
    throw new Error('A public hostname is required');
  }
  return url;
}

/** Fetch a bounded public document without redirects, shared sockets or credentials. */
export async function fetchPublicJson(value: string): Promise<unknown> {
  const url = assertPublicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    let finished = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        request?.destroy();
        response?.destroy();
        reject(error);
      } else resolve(result);
    };
    // Starts before DNS resolution, so stalled DNS is included in the deadline.
    const timer = setTimeout(() => finish(new Error('Remote document request timed out')), TIMEOUT_MS);
    const addresses = isIP(hostname)
      ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
      : dns.lookup(hostname, { all: true, verbatim: true });
    void addresses.then(records => {
      if (finished) return;
      if (!records.length || records.some(record => !isPublicAddress(record.address))) {
        finish(new Error('Private or reserved remote addresses are not allowed'));
        return;
      }
      const selected = records[0];
      request = https.get(url, {
        agent: false,
        family: selected.family,
        // Keep hostname for TLS verification/SNI, but pin connection lookup to
        // the previously validated address. No second DNS lookup can rebind it.
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        headers: { Accept: 'application/json' },
      }, incoming => {
        response = incoming;
        if (finished) { incoming.destroy(); return; }
        incoming.on('error', () => finish(new Error('Remote document response failed')));
        if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode >= 300) {
          finish(new Error('Remote document must return a successful status without redirects'));
          return;
        }
        const mediaType = (incoming.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mediaType)) {
          finish(new Error('Remote document must have a JSON content type'));
          return;
        }
        if (Number(incoming.headers['content-length']) > MAX_BYTES) {
          finish(new Error('Remote document exceeds the size limit'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          if (finished) return;
          size += chunk.length;
          if (size > MAX_BYTES) { finish(new Error('Remote document exceeds the size limit')); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (finished) return;
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new Error('Remote document contains invalid JSON')); }
        });
        incoming.on('close', () => {
          if (!incoming.complete) finish(new Error('Remote document response was incomplete'));
        });
      });
      request.on('error', () => finish(new Error('Remote document request failed')));
    }).catch(() => finish(new Error('Remote document could not be fetched')));
  });
}
