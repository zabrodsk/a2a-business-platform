import express from 'express';
import type { Actor } from '../../../packages/contracts/index.js';
import { BusinessError } from '../../../packages/contracts/index.js';
import type { LegacyStore } from '../../../packages/demo-garage/index.js';
import { BOOKING_CONFIG } from '../../../packages/demo-garage/index.js';
import type { AgentPolicy } from './agent-policy.js';
import type { PaymentWorkflow } from './payment-workflow.js';

export const validDemoSession = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function demoCustomer(store: LegacyStore, session: string): Actor {
  if (!validDemoSession(session)) throw new BusinessError('INVALID_DEMO_SESSION', 'Use the same UUID v4 X-Demo-Session as your A2A conversation.', 400);
  const customer_id = `demo-customer-${session}`;
  store.db.prepare('INSERT OR IGNORE INTO customers VALUES(?,?,?,?,?)').run(customer_id, 'Fictional chat-demo customer', `${session}@demo.invalid`, '', 'demo_chat');
  return { id: `demo:${session}`, role: 'customer_agent', customer_id };
}

export function demoChatRouter(options: { store: LegacyStore; policy: AgentPolicy; processor: PaymentWorkflow; enabled: () => boolean; validateTask?: (actor: Actor, id: string) => Promise<boolean> }) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }), (req, res, next) => {
    try {
      if (!options.enabled()) throw new BusinessError('DEMO_DISABLED', 'Chat approval is not enabled for this fictional demo.', 404);
      if (req.header('authorization') || req.header('cookie')) throw new BusinessError('DEMO_SESSION_REQUIRED', 'Use the isolated demo session, without account credentials.', 400);
      req.legacyActor = demoCustomer(options.store, req.header('x-demo-session') ?? '');
      options.policy.rulebooks.getActive();
      res.set('Cache-Control', 'no-store'); next();
    } catch (error) { next(error); }
  });
  r.post('/cases', async (req, res) => {
    const task = req.body?.relay_task_id;
    if (typeof task !== 'string' || !options.validateTask || !await options.validateTask(req.legacyActor!, task)) throw new BusinessError('RELAY_TASK_FORBIDDEN', 'Use your own A2A task.', 403);
    const prior = options.policy.listCases(req.legacyActor!).find(c => c.relay_task_id === task);
    res.status(prior ? 200 : 201).json({ simulation: true, case: prior ?? options.policy.createCase(req.legacyActor!, req.body) });
  });
  r.get('/cases/:id', (req, res) => {
    const c = options.policy.getCase(req.legacyActor!, String(req.params.id));
    const q = c.quote_id ? options.store.getQuote(c.quote_id) : null;
    const slot = q ? options.store.db.prepare('SELECT start_at,end_at FROM calendar_slots WHERE id=?').get(q.slot_id) : null;
    res.json({ simulation: true, case: c, quote: q, slot, consent_source: 'agent_relayed_demo_chat', independent_human_verification: false,
      approval_request: q ? { quote_id: q.id, quote_hash: c.quote_hash, quote_version: q.version, slot_id: q.slot_id, total_minor: q.price.total_minor, deposit_minor: BOOKING_CONFIG.deposit_minor, currency: q.price.currency, simulation: true, confirmation: 'yes_i_approve' } : null,
      order: c.order_id ? options.store.getOrder(c.order_id) : null,
      booking: c.order_id ? options.store.calendar(c.customer_id).find(b => b.order_id === c.order_id) ?? null : null,
      instruction: 'Show the exact business, service, appointment, total and simulated deposit. Submit approval_request only after the customer explicitly agrees. This creates a fictional reservation with local simulated funding; no money or testnet funds are transferred.' });
  });
  r.post('/cases/:id/approve', async (req, res) => {
    const accepted = options.policy.acceptDemoChat(req.legacyActor!, String(req.params.id), req.body);
    await options.processor.reconcile(accepted.intent.intent_id);
    const order = options.store.getOrder(accepted.order.id);
    res.json({ simulation: true, consent_source: 'agent_relayed_demo_chat', independent_human_verification: false, actual_money_charged: false,
      order, booking: options.store.calendar(order.customer_id).find(b => b.order_id === order.id) ?? null,
      intent: options.store.getPaymentIntent(accepted.intent.intent_id), notice: 'Fictional reservation; deposit funding is a local simulation, not a Stripe or blockchain payment.' });
  });
  return r;
}
