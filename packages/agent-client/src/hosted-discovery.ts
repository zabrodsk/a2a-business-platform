import { discoverWebsites, validateCandidates, type DocumentFetcher } from './website-discovery.js';

/** Public metadata scanner. Limits apply to everyone sharing this server instance. */
export function createHostedDiscovery(options: { fetchDocument?: DocumentFetcher; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let active = 0;
  const accepted: number[] = []; // At most eight timestamps; no per-caller memory.
  return async (input: unknown): Promise<{ status: number; body: unknown; retryAfter?: number }> => {
    let body: { candidates: ReturnType<typeof validateCandidates>; service?: string; area?: string; limit: number };
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some(key => !['candidates', 'service', 'area', 'limit'].includes(key))) throw new Error();
      if (!Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 10) throw new Error();
      const candidates = validateCandidates(value.candidates);
      for (const key of ['service', 'area'] as const) {
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).length > 200)) throw new Error();
      }
      const limit = value.limit === undefined ? 10 : value.limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10) throw new Error();
      body = { candidates, service: value.service as string | undefined, area: value.area as string | undefined, limit: Number(limit) };
    } catch { return { status: 400, body: { error: 'Invalid discovery request' } }; }
    const timestamp = now();
    while (accepted.length && accepted[0] <= timestamp - 60_000) accepted.shift();
    if (active >= 2 || accepted.length >= 8) return { status: 429, body: { error: 'Discovery is busy; retry later' }, retryAfter: 60 };
    active++; accepted.push(timestamp);
    try {
      const report = await discoverWebsites(body.candidates, { service: body.service, area: body.area, limit: body.limit, fetchDocument: options.fetchDocument });
      return { status: 200, body: report };
    } catch { return { status: 503, body: { error: 'Discovery is temporarily unavailable' } }; }
    finally { active--; }
  };
}
