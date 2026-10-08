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

export type PublicDocument = { url: string; status: number; headers: { 'content-type'?: string; link?: string }; body: string };
export type PublicDocumentOptions = {
  followRedirects?: boolean;
  jsonOnly?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Called before every network request, including redirected requests. */
  onRequest?: (url: string) => void;
};

/** Credentials-free public HTTPS GET, with DNS validation and socket pinning on every hop. */
export async function fetchPublicDocument(value: string, options: PublicDocumentOptions = {}): Promise<PublicDocument> {
  const deadline = Date.now() + Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  if (deadline <= Date.now() || maxBytes < 1) throw new Error('Remote document request timed out');
  async function visit(target: string, redirects: number): Promise<PublicDocument> {
    const url = assertPublicUrl(target);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve, reject) => {
      let finished = false;
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const finish = (error?: Error, result?: PublicDocument) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) { request?.destroy(); response?.destroy(); reject(error); }
        else resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error('Remote document request timed out')), Math.max(0, deadline - Date.now()));
      const addresses = isIP(hostname)
        ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
        : dns.lookup(hostname, { all: true, verbatim: true });
      void addresses.then(records => {
        if (finished) return;
        if (!records.length || records.some(record => !isPublicAddress(record.address))) {
          finish(new Error('Private or reserved remote addresses are not allowed')); return;
        }
        const selected = records[0];
        try { options.onRequest?.(url.href); }
        catch { finish(new Error('Discovery request limit reached')); return; }
        request = https.get(url, {
          agent: false,
          family: selected.family,
          lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
          headers: { Accept: options.jsonOnly ? 'application/json' : 'application/json, text/html, text/plain' },
        }, incoming => {
          response = incoming;
          if (finished) { incoming.destroy(); return; }
          incoming.on('error', () => finish(new Error('Remote document response failed')));
          const status = incoming.statusCode ?? 0;
          const headers = {
            'content-type': incoming.headers['content-type'],
            link: Array.isArray(incoming.headers.link) ? incoming.headers.link.join(', ') : incoming.headers.link,
          };
          if (options.followRedirects && [301, 302, 303, 307, 308].includes(status) && incoming.headers.location) {
            if (redirects >= 3) { finish(new Error('Remote document redirect limit reached')); return; }
            let destination: URL;
            try { destination = assertPublicUrl(new URL(incoming.headers.location, url).href); }
            catch { finish(new Error('Unsafe remote document redirect')); return; }
            finished = true;
            clearTimeout(timer);
            incoming.destroy();
            void visit(destination.href, redirects + 1).then(resolve, reject);
            return;
          }
          if (status < 200 || status >= 300) {
            finish(undefined, { url: url.href, status, headers, body: '' });
            incoming.destroy(); return;
          }
          if (Number(incoming.headers['content-length']) > maxBytes) {
            finish(new Error('Remote document exceeds the size limit')); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (finished) return;
            size += chunk.length;
            if (size > maxBytes) { finish(new Error('Remote document exceeds the size limit')); return; }
            chunks.push(chunk);
          });
          incoming.on('end', () => finish(undefined, { url: url.href, status, headers, body: Buffer.concat(chunks).toString('utf8') }));
          incoming.on('close', () => { if (!incoming.complete) finish(new Error('Remote document response was incomplete')); });
        });
        request.on('error', () => finish(new Error('Remote document request failed')));
      }).catch(() => finish(new Error('Remote document could not be fetched')));
    });
  }
  return visit(value, 0);
}

/** Registry verification retains its original no-redirect, JSON-only contract. */
export async function fetchPublicJson(value: string): Promise<unknown> {
  // Keep the JSON Accept header for existing registry behavior.
  const document = await fetchPublicDocument(value, { jsonOnly: true });
  if (document.status < 200 || document.status >= 300) throw new Error('Remote document must return a successful status without redirects');
  const mediaType = (document.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mediaType)) throw new Error('Remote document must have a JSON content type');
  try { return JSON.parse(document.body); }
  catch { throw new Error('Remote document contains invalid JSON'); }
}
