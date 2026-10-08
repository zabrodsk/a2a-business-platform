import { readFileSync } from 'node:fs';
import { A2A_PROTOCOL_VERSION, type AgentCard } from '@a2a-js/sdk';
import type { Config } from './config.js';

export interface BusinessProfile {
  name: string;
  organization: string;
  description: string;
  location?: { latitude: number; longitude: number; address: string };
  skill: { id: string; name: string; description: string; tags: string[]; examples: string[] };
  /** Public website content (home page + llms.txt). */
  site: { title: string; tagline: string; facts: string[]; phone: string; phoneNote: string; notice: string };
}

/** Public-facing business description, from profiles/<BUSINESS_PROFILE>.json. */
export function loadProfile(id: string): BusinessProfile {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid BUSINESS_PROFILE ${id}`);
  return JSON.parse(readFileSync(new URL(`../profiles/${id}.json`, import.meta.url), 'utf8'));
}

// Public card. Declares only what the relay actually implements: JSON-RPC binding,
// v1.0, bearer auth, push notifications (to allowlisted hosts), no streaming.
// No internal rules, prices or keys belong here (scope-of-work §5.2).
export function buildAgentCard(cfg: Config): AgentCard {
  const p = loadProfile(cfg.businessProfile);
  return {
    name: p.name,
    description: p.description,
    supportedInterfaces: [
      { url: cfg.a2aEndpointUrl, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: { organization: p.organization, url: cfg.publicUrl },
    version: '0.1.0',
    documentationUrl: undefined,
    capabilities: { streaming: false, pushNotifications: true, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            scheme: 'Bearer',
            bearerFormat: 'opaque',
            description: 'Pre-issued demo token per customer identity (sandbox).',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        ...p.skill,
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain', 'application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
