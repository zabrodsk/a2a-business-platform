import { fail } from './store.js';
/** Explicit server capabilities. Product-specific runtime support requires its own evidence. */
export const NATIVE_CAPABILITIES = ['pneu.http','relay.polling','website.agent_card'];
/** Setup dependencies, not permissions: each human decision still uses the owner session. */
export const OPERATION_SETUP = {
  order: ['owner_rulebook_activation', 'agent_rulebook_probe', 'owner_operation_grant', 'agent_webhook_setup'],
  probe: {
    method: 'POST', path: '/businesses/:businessId/relay/probe', body: { phase: 'rulebook' },
    scope: 'relay.provision', operation_grant_required: false, webhook_required: false,
  },
  continuation: 'Ask for exact rulebook activation only after proposal preflight passes. After server-confirmed activation, immediately complete the private rulebook probe with your existing audit credential and authenticated HTTP polling. Only after it passes ask for operation permissions; register and test the webhook after that grant. Never wait for operation permissions or webhook setup before the probe. Reuse the current connection and keep checking the current gate with bounded authenticated reads or verified native continuation.',
};
export function assertCapabilities(required:string[],mcpVerified=false) {
  const supported=[...NATIVE_CAPABILITIES,...(mcpVerified?['pneu.mcp']:[])];
  const missing=required.filter(capability=>!supported.includes(capability));
  if(missing.length)fail('CAPABILITY_UNAVAILABLE',`Autonomous operation blocked; missing verified capabilities: ${missing.join(', ')}.`,409);
}
