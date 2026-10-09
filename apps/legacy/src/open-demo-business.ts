import express from 'express';
import { createHash } from 'node:crypto';
import { BusinessError, type Actor } from '../../../packages/contracts/index.js';
import type { LegacyStore } from '../../../packages/demo-garage/index.js';
import type { AgentPolicy } from './agent-policy.js';
import type { HandoruStore } from './handoru/store.js';

/** A public facade over the already configured fictional shop, not fresh owner onboarding. */
export function openDemoBusinessRouter(o: { enabled: () => boolean; actor: () => Actor | undefined; store: LegacyStore; policy: AgentPolicy; handoru: HandoruStore; publicUrl: string }) {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }), (req, res, next) => {
    try {
      if (!o.enabled()) throw new BusinessError('DEMO_DISABLED', 'Open business demo is not enabled.', 404);
      const actor = o.actor();
      if (!actor || actor.business_id !== 'pneu007') throw new BusinessError('DEMO_UNAVAILABLE', 'The prepared fictional shop is unavailable.', 503);
      o.handoru.authorize(actor, 'pneu007', 'inbox.claim', true);
      o.policy.rulebooks.getActive(); req.legacyActor = actor;
      res.set('Cache-Control', 'no-store'); next();
    } catch (error) { next(error); }
  });
  const ownDemoCase = (actor: Actor, id: string) => {
    const c = o.policy.getCase(actor, id);
    if (c.business_id !== 'pneu007' || !c.customer_agent_id.startsWith('demo:') || !c.customer_id.startsWith('demo-customer-')) throw new BusinessError('CASE_NOT_FOUND', 'Unknown demo case.', 404);
    return c;
  };
  r.post('/connect', (_req, res) => res.json({ mode: 'open_demo', business_id: 'pneu007', authentication: 'none', owner_approval_required: false, ownership_proof_required: false,
    tools_base: `${o.publicUrl}/demo-business`, inbox_url: `${o.publicUrl}/demo-business/bot`, client_url: `${o.publicUrl}/cli/demo-business.mjs`,
    automatic_reply_mode: 'webhook', webhook_key_entry: 'native_grok_masked_input', simulation: true, user_message: 'The demo shop is connected. I’m setting up automatic replies.' }));
  r.get('/profile', (_req, res) => res.json({ name: 'Pneu 007', location: 'Holešovice, Prague 7', fictional: true, setup_mode: 'open_demo', authentication: 'none', funding: 'local_simulation_only' }));
  r.get('/catalog', (_req, res) => res.json(o.store.catalog()));
  r.get('/rulebook', (_req, res) => res.json({ rulebook: o.policy.rulebooks.getActive(), simulation: true, instruction: 'Use these existing demo rules. Do not propose new rules, start owner pairing, request approval codes or publish ownership proof for this demo.' }));
  r.get('/schedule', (req, res) => res.json({ slots: o.store.availability({ service_id: typeof req.query.service_id === 'string' ? req.query.service_id : undefined, from: typeof req.query.from === 'string' ? req.query.from : undefined, to: typeof req.query.to === 'string' ? req.query.to : undefined }), timezone: 'Europe/Prague' }));
  r.get('/cases', (req, res) => res.json({ cases: o.policy.listCases(req.legacyActor!).filter(c => c.business_id === 'pneu007' && c.customer_agent_id.startsWith('demo:') && c.customer_id.startsWith('demo-customer-')) }));
  r.get('/cases/:id', (req, res) => {
    const c = ownDemoCase(req.legacyActor!, String(req.params.id));
    res.json({ case: c, quote: c.quote_id ? o.store.getQuote(c.quote_id) : null });
  });
  r.post('/cases/:id/quotes', (req, res) => {
    const actor = req.legacyActor!, c = ownDemoCase(actor, String(req.params.id));
    // A replay of the same intended quote must not create another offer.
    const key = `open-demo:${c.id}:${createHash('sha256').update(JSON.stringify(req.body)).digest('hex')}`;
    const result = o.handoru.operation(actor, key, 'quote.create', { case_id: c.id, ...req.body }, 'cases.quote', () => o.policy.quote(actor, c.id, req.body));
    res.status(201).json(result);
  });
  r.get('/orders/:id', (req, res) => {
    const order = o.store.getOrder(String(req.params.id));
    const c = o.policy.listCases(req.legacyActor!).find(c => c.order_id === order.id);
    if (!c) throw new BusinessError('ORDER_NOT_FOUND', 'Unknown demo order.', 404);
    ownDemoCase(req.legacyActor!, c.id);
    const intent = o.store.listPaymentIntents().find(i => i.order_id === order.id);
    if (intent && (intent.provider !== 'local_demo' || intent.authorization.kind !== 'demo_chat')) throw new BusinessError('DEMO_ONLY', 'This order is outside the open demo.', 404);
    res.json({ order, quote: o.store.getQuote(order.quote_id), booking: o.store.calendar(c.customer_id).find(b => b.order_id === order.id) ?? null, intent: intent ?? null, simulation: true });
  });
  r.get('/reservations', (req, res) => {
    const orderIds = new Set(o.policy.listCases(req.legacyActor!).filter(c => c.customer_agent_id.startsWith('demo:') && c.customer_id.startsWith('demo-customer-')).map(c => c.order_id));
    res.json({ reservations: o.store.calendar().filter(b => orderIds.has(b.order_id)), timezone: 'Europe/Prague', simulation: true });
  });
  return r;
}
