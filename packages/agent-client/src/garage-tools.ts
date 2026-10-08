export interface GarageTool {
  name: string;
  description: string;
  method: 'GET' | 'POST';
  path: string;
  arguments: { name: string; required: boolean; location: 'path' | 'query' | 'file'; parameter?: string; values?: string[] }[];
  read_only: boolean;
}

const payload = { name: '--data-file', required: true, location: 'file' as const };
const identifier = (name: string) => ({ name, required: true, location: 'path' as const });
const dates = [
  { name: '--from', required: false, location: 'query' as const, parameter: 'from' },
  { name: '--to', required: false, location: 'query' as const, parameter: 'to' },
];

/** Named business tools; authentication and domain policy remain enforced by the backend. */
export const GARAGE_TOOLS: GarageTool[] = [
  { name: 'profile', description: 'Read business identity, agent capabilities and setup status.', method: 'GET', path: '/api/agent/profile', arguments: [], read_only: true },
  { name: 'payments', description: 'Read payment provider, network, registered prices and configuration status.', method: 'GET', path: '/api/payments/config', arguments: [], read_only: true },
  { name: 'masumi-availability', description: 'Check whether the Masumi seller service is available.', method: 'GET', path: '/masumi/availability', arguments: [], read_only: true },
  { name: 'masumi-schema', description: 'Read the Masumi seller job input schema and purchaser identifier constraints.', method: 'GET', path: '/masumi/input_schema', arguments: [], read_only: true },
  { name: 'masumi-start', description: 'Customer agent: prepare one seller job for an accepted, human-authorized order. Does not initiate buyer payment.', method: 'POST', path: '/masumi/start_job', arguments: [payload], read_only: false },
  { name: 'masumi-status', description: 'Read and reconcile an authorized Masumi job, including its result and integrity hashes.', method: 'GET', path: '/masumi/status', arguments: [{ name: '--job', required: true, location: 'query', parameter: 'job_id' }], read_only: true },
  { name: 'catalog', description: 'Read services, prices, booking configuration and resources.', method: 'GET', path: '/api/services', arguments: [], read_only: true },
  { name: 'price', description: 'Calculate a price for a service specification without creating a booking.', method: 'POST', path: '/api/pricing/calculate', arguments: [payload], read_only: true },
  { name: 'sources', description: 'List authorized business audit sources.', method: 'GET', path: '/api/audit/sources', arguments: [], read_only: true },
  { name: 'source', description: 'Export one authorized business audit source.', method: 'GET', path: '/api/audit/export/:id', arguments: [identifier('id')], read_only: true },
  { name: 'rulebook', description: 'Read the active owner-approved operating rulebook.', method: 'GET', path: '/api/agent/rulebook', arguments: [], read_only: true },
  { name: 'propose-rulebook', description: 'Submit a proposed rulebook for owner review; does not activate it.', method: 'POST', path: '/api/agent/rulebook/proposals', arguments: [payload], read_only: false },
  { name: 'publish-registry-proof', description: 'Publish the registry business_id and challenge at the fixed website verification path; does not activate booking or verify the registry listing.', method: 'POST', path: '/api/agent/registry-proof', arguments: [payload], read_only: false },
  { name: 'cases', description: 'List customer cases accessible to this agent.', method: 'GET', path: '/api/agent/cases', arguments: [], read_only: true },
  { name: 'case', description: 'Read an accessible customer case.', method: 'GET', path: '/api/agent/cases/:id', arguments: [identifier('id')], read_only: true },
  { name: 'availability', description: 'Find available service slots within an optional time window.', method: 'GET', path: '/api/agent/availability', arguments: [{ name: '--service', required: false, location: 'query', parameter: 'service_id' }, ...dates], read_only: true },
  { name: 'quote', description: 'Create a policy-checked offer for a customer case.', method: 'POST', path: '/api/agent/cases/:id/quotes', arguments: [identifier('id'), payload], read_only: false },
  { name: 'order', description: 'Read order, payment and reservation status.', method: 'GET', path: '/api/agent/orders/:id', arguments: [identifier('id')], read_only: true },
  { name: 'checkout', description: 'Prepare checkout for an accepted order under customer authorization; payment verification confirms the booking.', method: 'POST', path: '/api/agent/orders/:id/checkout', arguments: [identifier('id')], read_only: false },
  { name: 'reservations', description: 'List reservations for cases assigned to this agent, optionally filtered by time and status.', method: 'GET', path: '/api/agent/reservations', arguments: [...dates, { name: '--status', required: false, location: 'query', parameter: 'status', values: ['confirmed', 'cancelled', 'service_completed'] }], read_only: true },
];

export function namedGarageRequest(positionals: string[], options: Map<string, string>): { method: string; path: string } {
  const tool = GARAGE_TOOLS.find(item => item.name === positionals[0]);
  if (!tool) throw new Error(`Unknown command ${positionals[0]}`);
  const pathArguments = tool.arguments.filter(argument => argument.location === 'path');
  if (positionals.length !== 1 + pathArguments.length) throw new Error(`Invalid arguments for ${tool.name}`);
  for (const option of options.keys()) {
    if (!tool.arguments.some(argument => argument.name === option)) throw new Error(`${option} is not supported by ${tool.name}`);
  }
  let path = tool.path;
  for (const [index, argument] of pathArguments.entries()) {
    const value = positionals[index + 1]!;
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${argument.name}: use letters, numbers, underscores or hyphens`);
    path = path.replace(`:${argument.name}`, encodeURIComponent(value));
  }
  const query = new URLSearchParams();
  for (const argument of tool.arguments.filter(argument => argument.location !== 'path')) {
    const value = options.get(argument.name);
    if (argument.required && value === undefined) throw new Error(`${tool.name} requires ${argument.name}`);
    if (value === undefined) continue;
    if (argument.values && !argument.values.includes(value)) throw new Error(`Invalid ${argument.name}: expected ${argument.values.join(', ')}`);
    if (argument.location === 'query') query.set(argument.parameter!, value);
  }
  return { method: tool.method, path: path + (query.size ? `?${query}` : '') };
}
