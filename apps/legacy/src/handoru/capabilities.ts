import { fail } from './store.js';
/** Explicit server capabilities. Product-specific runtime support requires its own evidence. */
export const NATIVE_CAPABILITIES = ['pneu.http','relay.polling','website.agent_card'];
export function assertCapabilities(required:string[],mcpVerified=false) {
  const supported=[...NATIVE_CAPABILITIES,...(mcpVerified?['pneu.mcp']:[])];
  const missing=required.filter(capability=>!supported.includes(capability));
  if(missing.length)fail('CAPABILITY_UNAVAILABLE',`Autonomous operation blocked; missing verified capabilities: ${missing.join(', ')}.`,409);
}
