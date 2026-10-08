import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverWebsites, type DocumentFetcher } from './website-discovery.js';

const help = `Website-first A2A discovery (public GET only)
Usage: node discover-sites.mjs --sites-file candidates.json [--output report.json] [--service tyre_change] [--area "Prague 6"] [--limit 10]
First use your browser to find real businesses and their official HTTPS websites.
Candidates: JSON array of {name,website,source_url?,address?}, at most 20 entries and 32 KB.
This scans candidate websites; it does not search Maps, query a registry, enroll, message, book or pay.
Service and area annotate the request; evaluate relevance using browser search evidence.
`;
export async function discoverSitesMain(args: string[], dependencies: { fetchDocument?: DocumentFetcher; stdout?: (text: string) => void } = {}) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    'sites-file': { type: 'string' }, output: { type: 'string' }, service: { type: 'string' }, area: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean', short: 'h' },
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
  const report = await discoverWebsites(input, { service: values.service, area: values.area, limit: values.limit ? Number(values.limit) : undefined, fetchDocument: dependencies.fetchDocument });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, text, { mode: 0o600 });
  stdout(text);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) discoverSitesMain(process.argv.slice(2)).catch(() => {
  process.stderr.write('Website discovery failed. Check the candidate JSON, options and output path; no remote response bodies are logged.\n');
  process.exitCode = 1;
});
