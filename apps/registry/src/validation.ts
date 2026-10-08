export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${field}`);
  return value.trim();
}
export function httpsUrl(value: unknown, field: string): URL {
  let url: URL;
  try { url = new URL(text(value, field, 2048)); } catch { throw new HttpError(400, `Invalid ${field}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('#') || url.port || url.hostname.endsWith('.')) throw new HttpError(400, `${field} must be an HTTPS URL on port 443 without credentials, fragment, or trailing-dot hostname`);
  return url;
}
export interface Listing {
  name: string;
  description: string;
  website: string;
  agent_card_url: string;
  services: string[];
  actions: string[];
  location: { latitude: number; longitude: number; address: string };
}
const fields = ['name', 'description', 'website', 'agent_card_url', 'services', 'actions', 'location'];
export function validateListing(value: unknown, previous?: Listing): Listing {
  const input = object(value);
  if (!Object.keys(input).length || Object.keys(input).some(key => !fields.includes(key))) throw new HttpError(400, 'Unknown or empty business fields');
  const data = { ...previous, ...input };
  const website = httpsUrl(data.website, 'website');
  if (website.pathname !== '/' || website.search) throw new HttpError(400, 'website must be an origin without path or query');
  const card = httpsUrl(data.agent_card_url, 'agent_card_url');
  if (card.origin !== website.origin) throw new HttpError(400, 'Agent Card must share the website origin');
  function list(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 50) throw new HttpError(400, `Invalid ${field}`);
    const entries = value.map(item => text(item, field, 80).toLowerCase());
    if (entries.some(item => !/^[a-z0-9][a-z0-9_-]*$/.test(item))) throw new HttpError(400, `Invalid ${field} identifier`);
    return [...new Set(entries)];
  }
  const services = list(data.services, 'services');
  const actions = list(data.actions, 'actions');
  if (actions.some(action => !['information', 'quote', 'book', 'cancel', 'reschedule'].includes(action))) throw new HttpError(400, 'Unsupported action');
  const location = object(data.location);
  if (Object.keys(location).some(key => !['latitude', 'longitude', 'address'].includes(key))) throw new HttpError(400, 'Unknown location field');
  const { latitude, longitude } = location;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new HttpError(400, 'Invalid location coordinates');
  return { name: text(data.name, 'name'), description: text(data.description, 'description', 2000), website: website.origin, agent_card_url: card.href, services, actions, location: { latitude, longitude, address: text(location.address, 'address', 500) } };
}
export function validateCard(value: unknown, listing: Listing): void {
  const card = object(value);
  text(card.name, 'card.name');
  if (!Array.isArray(card.skills) || !card.skills.length || card.skills.some(skill => !skill || typeof skill !== 'object' || typeof skill.id !== 'string' || !skill.id.trim())) throw new Error('Agent Card requires skills with nonempty IDs');
  if (!Array.isArray(card.supportedInterfaces) || !card.supportedInterfaces.length) throw new Error('Agent Card requires supportedInterfaces');
  for (const entry of card.supportedInterfaces) {
    const iface = object(entry);
    if (iface.protocolVersion !== '1.0' || !['JSONRPC', 'HTTP+JSON', 'GRPC'].includes(String(iface.protocolBinding))) throw new Error('Agent Card interface must use A2A 1.0 and a supported binding');
    if (httpsUrl(iface.url, 'interface.url').origin !== listing.website) throw new Error('Agent interface must share the verified website origin');
  }
}
export interface Search {
  service?: string; action?: string; q?: string; lat?: number; lon?: number; radius?: number; limit: number; offset: number;
}
export function validateSearch(query: Record<string, unknown>): Search {
  const allowed = ['service', 'action', 'q', 'lat', 'lon', 'radius_km', 'limit', 'offset'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown search parameter');
  for (const value of Object.values(query)) if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Search parameters must be nonempty scalar strings');
  function number(key: string, min: number, max: number, integer = false): number | undefined {
    if (query[key] === undefined) return undefined;
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(query[key]))) throw new HttpError(400, `Invalid ${key}`);
    const value = Number(query[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new HttpError(400, `Invalid ${key}`);
    return value;
  }
  const lat = number('lat', -90, 90), lon = number('lon', -180, 180), radius = number('radius_km', 0.01, 20050);
  if ((lat === undefined) !== (lon === undefined) || (radius !== undefined && lat === undefined)) throw new HttpError(400, 'Coordinates must be paired; radius requires coordinates');
  const service = query.service as string | undefined, action = query.action as string | undefined;
  if (service && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(service)) throw new HttpError(400, 'Invalid service');
  if (action && !['information', 'quote', 'book', 'cancel', 'reschedule'].includes(action)) throw new HttpError(400, 'Invalid action');
  return { service, action, q: query.q === undefined ? undefined : text(query.q, 'q'), lat, lon, radius, limit: number('limit', 1, 100, true) ?? 20, offset: number('offset', 0, 100000, true) ?? 0 };
}
export function distanceKm(lat: number, lon: number, location: Listing['location']): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const a = Math.sin(radians(location.latitude - lat) / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(location.latitude)) * Math.sin(radians(location.longitude - lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}
