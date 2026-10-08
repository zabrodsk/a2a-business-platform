import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverWebsites, validateCandidates, type DocumentFetcher } from './website-discovery.js';
import { assertPublicUrl } from './public-web.js';

const help = `Website-first A2A discovery (public GET only)
Usage: node discover-sites.mjs --sites-file candidates.json [--output report.json] [--service tyre_change] [--area "Prague 6"] [--limit 10] [--via https://trusted-platform-origin]
First use your browser to find real businesses and their official HTTPS websites.
Candidates: JSON array of {name,website,source_url?,address?}, at most 20 entries and 32 KB.
This scans candidate websites; it does not search Maps, query a registry, enroll, message, book or pay.
Use --via with your operator's trusted platform origin when your runtime proxies DNS. It sends at most 10 candidate sites to the hosted scanner; upstream website requests remain public GETs.
Service and area annotate the request; evaluate relevance using browser search evidence.
`;
// Ten protected upstream cards may each contain up to 256 KiB, plus evidence.
const MAX_HOSTED_BYTES = 4 * 1024 * 1024;
async function hostedScan(origin: string, input: unknown, values: { service?: string; area?: string; limit?: string }, request: typeof fetch) {
  const url = assertPublicUrl(origin);
  if (url.pathname !== '/' || url.search) throw new Error('--via must be a trusted platform origin');
  const candidates = validateCandidates(input), limit = Number(values.limit ?? 10);
  if (candidates.length > 10 || limit > 10) throw new Error('Hosted discovery accepts at most 10 candidates');
  for (const value of [values.service, values.area]) if (value !== undefined && (!value.trim() || value.length > 200)) throw new Error('Invalid request annotation');
  const response = await request(`${url.origin}/discovery/websites`, {
    method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(95_000),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ candidates, ...(values.service ? { service: values.service } : {}), ...(values.area ? { area: values.area } : {}), limit }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 ? 'Hosted scanner busy; retry later' : 'Hosted scanner request failed'); }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') || Number(response.headers.get('content-length')) > MAX_HOSTED_BYTES) {
    await response.body?.cancel(); throw new Error('Invalid hosted discovery response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing hosted discovery response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_HOSTED_BYTES) throw new Error('Hosted discovery response exceeds limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Awaited<ReturnType<typeof discoverWebsites>>;
  if (!report || !report.request || !report.coverage || !Array.isArray(report.candidates) || report.candidates.length > 10
      || typeof report.coverage.incomplete !== 'boolean' || typeof report.coverage.scanned !== 'number') throw new Error('Invalid hosted discovery report');
  return { ...report, execution: { mode: 'hosted', origin: url.origin } };
}

export async function discoverSitesMain(args: string[], dependencies: { fetchDocument?: DocumentFetcher; hostedFetch?: typeof fetch; stdout?: (text: string) => void } = {}) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    'sites-file': { type: 'string' }, output: { type: 'string' }, service: { type: 'string' }, area: { type: 'string' }, limit: { type: 'string' }, via: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const stdout = dependencies.stdout ?? (text => process.stdout.write(text));
  if (values.help) { stdout(help); return; }
  if (positionals.length || !values['sites-file']) throw new Error('--sites-file is required; positional arguments are unsupported');
  if (values.limit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(values.limit)) throw new Error('--limit must be an integer from 1 to 20');
  let input: unknown;
  const fd = openSync(values['sites-file'], 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 32 * 1024) throw new Error('Candidate file must be a regular file at most 32 KB');
    const bytes = Buffer.alloc(32 * 1024 + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 32 * 1024) throw new Error('Candidate file exceeds 32 KB');
    try { input = JSON.parse(bytes.subarray(0, size).toString('utf8')); } catch { throw new Error('Candidate file contains invalid JSON'); }
  } finally { closeSync(fd); }
  const report = values.via ? await hostedScan(values.via, input, values, dependencies.hostedFetch ?? fetch)
    : await discoverWebsites(input, { service: values.service, area: values.area, limit: values.limit ? Number(values.limit) : undefined, fetchDocument: dependencies.fetchDocument });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, text, { mode: 0o600 });
  stdout(text);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) discoverSitesMain(process.argv.slice(2)).catch(() => {
  process.stderr.write('Website discovery failed. Check the candidate JSON, options and output path; no remote response bodies are logged.\n');
  process.exitCode = 1;
});
