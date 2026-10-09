import express from 'express';
import type Database from 'better-sqlite3';
import { BusinessError, type Actor } from '../../../packages/contracts/index.js';
import { canonical, hash } from './handoru/store.js';
import { CustomerIdentity, type CustomerBusiness } from './customer-identity.js';
import { CustomerBusinessAccess, customerOrigin } from './customer-business-access.js';
import type { AgentPolicy, AgentMandate } from './agent-policy.js';
import type { LegacyConfig } from './config.js';

const PREFIX = '/api/handle/customer/v1';
function fail(message: string, status = 400): never { throw new BusinessError('CUSTOMER_IDENTITY_ERROR', message, status); }
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) fail('Supply a valid identifier.');
  return value;
};
function mandateHash(mandate: AgentMandate): string {
  const { status: _status, approved_by: _actor, approved_at: _date, ...terms } = mandate;
  return hash(canonical(terms));
}

/** Explicit deployment configuration supplies trust. No public registry/card can register an identity issuer. */
export function customerIdentityIntegration(cfg: LegacyConfig, db: Database.Database, policy: AgentPolicy,
  nativeBusinessId: () => string, options: { now: () => Date; request?: typeof fetch }) {
  const enabled = cfg.env.HANDLE_CUSTOMER_IDENTITY_ENABLED === 'true';
  const issuerUrl = cfg.env.HANDLE_CUSTOMER_ISSUER_URL ?? (enabled ? cfg.publicUrl : undefined);
  if (!issuerUrl) return {};
  const issuerOrigin = customerOrigin(issuerUrl);
  const configured: unknown = enabled ? JSON.parse(cfg.env.HANDLE_CUSTOMER_BUSINESSES ?? '[]') : [];
  if (!Array.isArray(configured)) throw new Error('HANDLE_CUSTOMER_BUSINESSES must contain a JSON array of trusted business resources.');
  const businesses = configured as CustomerBusiness[];
  if (enabled && issuerOrigin !== customerOrigin(cfg.publicUrl)) throw new Error('The customer issuer must run at its configured public origin.');
  const issuer = enabled ? new CustomerIdentity(db, { issuer: issuerOrigin, businesses, now: options.now }) : undefined;
  const configuredBusinessId = cfg.env.HANDLE_CUSTOMER_BUSINESS_ID;
  const serviceSecret = cfg.env.HANDLE_CUSTOMER_SERVICE_SECRET;
  if (!!configuredBusinessId !== !!serviceSecret) throw new Error('Customer business ID and service secret must be configured together.');
  if (!enabled && !configuredBusinessId) throw new Error('A remote customer issuer requires an explicitly configured business ID and service secret.');
  const federation = configuredBusinessId && serviceSecret ? new CustomerBusinessAccess(db, {
    issuer: issuerOrigin, business_id: configuredBusinessId, resource_url: cfg.publicUrl, service_secret: serviceSecret,
    nativeBusinessId, now: options.now, request: options.request, localIssuer: issuer,
  }) : undefined;
  if (issuer && federation) {
    const self = businesses.find(business => business.business_id === configuredBusinessId);
    if (!self || customerOrigin(self.resource_url) !== federation.resource || self.service_secret !== serviceSecret) {
      throw new Error('This business must match an explicitly trusted issuer resource.');
    }
  }
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (issuer) {
    router.use(PREFIX, issuer.router());
    const humanProxy = express.Router();
    humanProxy.use(express.json({ limit: '8kb' }), issuer.human);
    const proxy = async (businessId: string, connectionId: string, customerId: string, mandateId: string, reviewedHash?: string) => {
      const access = issuer.accessForCustomer(customerId, businessId, connectionId);
      if (!access.scope.split(' ').includes('customer.tools')) fail('Customer tools permission is required.', 403);
      const business = businesses.find(value => value.business_id === businessId);
      if (!business) fail('The business is not configured.', 403);
      const target = customerOrigin(business.resource_url);
      const ticket = reviewedHash ? issuer.createMandateDecision(customerId, businessId, connectionId, mandateId, reviewedHash) : undefined;
      let response: Response;
      try {
        response = await (options.request ?? fetch)(`${target}/api/customer-identity/mandates/${encodeURIComponent(mandateId)}/${reviewedHash ? 'approve' : 'review'}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${business.service_secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ connection_id: access.connection_id, grant_id: access.grant_id, sub: access.sub,
            ...(reviewedHash ? { mandate_hash: reviewedHash, decision_ticket: ticket } : {}) }),
        });
      } catch { fail('The business approval service is unavailable.', 503); }
      if (!response.ok) fail('The business rejected this mandate decision.', [401, 403, 404, 409].includes(response.status) ? response.status : 503);
      return { ...await response.json(), business: { business_id: business.business_id, resource_url: target } };
    };
    humanProxy.get('/businesses/:businessId/mandates/:mandateId', async (req, res) => {
      res.json(await proxy(id(req.params.businessId), id(req.query.connection_id), req.customerHuman!.id, id(req.params.mandateId)));
    });
    humanProxy.post('/businesses/:businessId/mandates/:mandateId/approve', async (req, res) => {
      if (!req.body || Object.keys(req.body).some(key => !['connection_id', 'mandate_hash'].includes(key)) || !/^[a-f0-9]{64}$/.test(req.body.mandate_hash ?? '')) fail('Review the exact mandate before approving.');
      res.json(await proxy(id(req.params.businessId), id(req.body.connection_id), req.customerHuman!.id, id(req.params.mandateId), req.body.mandate_hash));
    });
    router.use(PREFIX, humanProxy);
  }
  if (federation) {
    const metadata = { issuer: issuerOrigin, business_id: configuredBusinessId, resource: federation.resource,
      customer_portal: `${issuerOrigin}/handle/customer`, connection_registration_endpoint: `${issuerOrigin}${PREFIX}/connections/register`,
      token_endpoint: `${issuerOrigin}${PREFIX}/token`, scopes_supported: ['a2a', 'customer.tools'],
      protocol: 'handle-customer-v1', oidc_conformance: false };
    router.get(['/.well-known/handle-customer.json', '/api/customer-identity/metadata'], (_req, res) => res.json(metadata));
    const bridge = express.Router();
    bridge.use(express.json({ limit: '8kb' }));
    bridge.post('/mandates/:mandateId/:operation', async (req, res) => {
      if (!['review', 'approve'].includes(String(req.params.operation)) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !['connection_id', 'grant_id', 'sub', 'mandate_hash', 'decision_ticket'].includes(key))) fail('Invalid mandate operation.');
      const verified = await federation.humanGrant(req.header('authorization'), req.body);
      const human: Actor = { ...verified.actor, id: `handle-human:${hash(`${verified.access.iss}:${verified.access.sub}`)}`, role: 'human_customer' };
      const mandateId = id(req.params.mandateId);
      if (req.params.operation === 'approve') await federation.consumeHumanDecision(req.body.decision_ticket, mandateId, req.body.mandate_hash, verified.access);
      const result = db.transaction(() => {
        const mandate = policy.getMandate(human, mandateId);
        // A customer's other or revoked agent cannot inherit a pending human mandate.
        if (mandate.proposed_by !== verified.actor.id) fail('Mandate belongs to a different personal agent.', 403);
        const digest = mandateHash(mandate);
        if (req.params.operation === 'approve') {
          if (typeof req.body.mandate_hash !== 'string' || req.body.mandate_hash !== digest) fail('Mandate terms changed. Review them again.', 409);
          return { mandate: policy.approveMandate(human, mandateId), mandate_hash: digest };
        }
        return { mandate, mandate_hash: digest };
      }).immediate();
      res.json(result);
    });
    router.use('/api/customer-identity', bridge);
  }
  return { issuer, federation, router, issuerOrigin };
}
