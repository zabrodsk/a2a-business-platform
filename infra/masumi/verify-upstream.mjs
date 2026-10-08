import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Read-only verification: this script never builds, launches or executes upstream code.
const manifest = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
for (const [path, expected] of Object.entries(manifest.files)) {
  const url = `https://raw.githubusercontent.com/masumi-network/masumi-payment-service/${manifest.commit}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`Upstream verification failed: HTTP ${response.status} for ${path}`);
  const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if (actual !== expected) throw new Error(`Upstream checksum mismatch: ${path}`);
  console.log(`VERIFIED ${path} ${actual}`);
}
console.log(`Verified pinned upstream ${manifest.commit}. No containers or payment transactions launched.`);
