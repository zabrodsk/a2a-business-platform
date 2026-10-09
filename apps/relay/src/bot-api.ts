import express, { type Router } from 'express';
import type { Task } from '@a2a-js/sdk';
import { agentMessage, REPLY_STATES, stateName, summarizeMessage, type ReplyStateName } from './a2a-helpers.js';
import { hashToken, identify, identityAllowed, requireRole } from './auth.js';
import type { Config, Identity, RelayOperation } from './config.js';
import type { RelayDb, WorkItem } from './db.js';
import type { Doorbell } from './doorbell.js';
import { RelayAuthorizationError, RelayLeaseError, type RelayExecutor } from './executor.js';

// Private API for the Business GrokBot. This is NOT A2A; it is the inbox behind
// the public A2A endpoint (scope-of-work §6.4, §7.1).

const MAX_TEXT = 8000;
const MAX_DATA_BYTES = 32_000;

export function botRouter(cfg: Config, db: RelayDb, doorbell: Doorbell, executor: RelayExecutor): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.use(requireRole(cfg, 'business'));

  const allowed = (identity: Identity, operation: RelayOperation, authorization: string | undefined) => {
    const current = identify(cfg, authorization);
    if (!current || current.id !== identity.id || current.role !== identity.role
      || current.business_id !== identity.business_id || current.connection_id !== identity.connection_id
      || current.execution_epoch !== identity.execution_epoch || !identityAllowed(cfg, current, operation)
      || !identityAllowed(cfg, identity, operation)) throw new RelayAuthorizationError();
  };
  const view = async (item: WorkItem, identity: Identity, authorization: string | undefined) => {
    const task = await executor.loadForOwner(item.owner, item.task_id);
    allowed(identity, 'inbox.read', authorization);
    const history = task ? conversation(task).map(summarizeMessage) : [];
    const { authenticated_sender, ...message } = JSON.parse(item.message_json);
    if (!history.some((m) => m.message_id === item.customer_message_id)) history.push(message);
    return {
      work_item_id: item.id,
      task_id: item.task_id,
      context_id: item.context_id,
      ...(cfg.businessId ? {
        business_id: item.business_id, lease_token: item.lease_token,
        claim_generation: item.claim_generation, execution_epoch: item.claim_epoch,
        connection_id: item.claimed_by_connection_id, lease_until: item.lease_until,
      } : {}),
      customer: item.owner,
      customer_identity: authenticated_sender ?? { agent_id: item.owner, acting_for: null },
      turn: db.countRepliesForTask(item.task_id) + 1,
      max_turns: cfg.maxAgentTurns,
      history,
      reply_with: `POST /bot/reply with work_item_id, text, state${cfg.businessId ? ', lease_token and claim_generation from this claim' : ''}`,
    };
  };

  const claim = async (identity: Identity, authorization: string | undefined) => {
    allowed(identity, 'inbox.read', authorization);
    executor.hydrateAcceptedReplies();
    const items = db.claimAvailable(cfg.leaseMs, identity);
    for (const i of items) db.logEvent({ task_id: i.task_id, actor: identity.id, kind: 'work_claimed', detail: { work_item: i.id } });
    const views = await Promise.all(items.map((item) => view(item, identity, authorization)));
    allowed(identity, 'inbox.read', authorization);
    return views;
  };

  // Claim everything pending. Claimed items come back after LEASE_MS if not answered.
  r.get('/inbox', async (req, res) => {
    res.json({ items: await claim(req.identity!, req.header('authorization')) });
  });

  // Long-poll: returns as soon as something is pending, or empty after `timeout` seconds (max 55).
  r.get('/wait', async (req, res) => {
    const timeoutSeconds = Number(req.query.timeout ?? 50);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) return void res.status(400).json({ error: 'timeout must be a non-negative number' });
    const timeoutMs = Math.min(timeoutSeconds, 55) * 1000;
    allowed(req.identity!, 'inbox.read', req.header('authorization'));
    executor.hydrateAcceptedReplies();
    if (db.countAvailable(cfg.leaseMs, req.identity!) === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          doorbell.signal.off('work', done);
          req.off('close', done);
          resolve();
        };
        const t = setTimeout(done, timeoutMs);
        doorbell.signal.on('work', done);
        req.on('close', done);
      });
    }
    if (res.writableEnded || req.destroyed) return;
    res.json({ items: await claim(req.identity!, req.header('authorization')) });
  });

  r.post('/reply', async (req, res) => {
    const { work_item_id, text, data, state, lease_token, claim_generation } = req.body ?? {};
    if (typeof work_item_id !== 'string') return void res.status(400).json({ error: 'work_item_id is required' });
    if (typeof text !== 'string' || !text.trim()) return void res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_TEXT) return void res.status(400).json({ error: `text longer than ${MAX_TEXT} chars` });
    if (data !== undefined && Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) {
      return void res.status(400).json({ error: `data larger than ${MAX_DATA_BYTES} bytes` });
    }
    const stateKey = (state ?? 'input-required') as ReplyStateName;
    if (typeof stateKey !== 'string' || !Object.hasOwn(REPLY_STATES, stateKey)) {
      return void res.status(400).json({ error: `state must be one of ${Object.keys(REPLY_STATES).join(', ')}` });
    }
    const item = db.getWorkItem(work_item_id);
    if (!item) return void res.status(404).json({ error: 'unknown work_item_id' });
    if (item.status === 'cancelled') return void res.status(409).json({ error: 'task was canceled by the customer' });

    const message = agentMessage(item.task_id, item.context_id, text, data);
    const outcome = await executor.submitReply(item, { state: REPLY_STATES[stateKey], message }, req.identity!, { token: lease_token, generation: claim_generation });
    allowed(req.identity!, 'inbox.reply', req.header('authorization'));
    if (outcome === 'duplicate') {
      return void res.status(200).json({ ok: true, duplicate: true, note: 'this work item was already answered' });
    }
    res.json({ ok: true, task_id: item.task_id, state: stateKey, delivered: outcome });
  });

  const credentialHash = (req: express.Request) => hashToken(req.header('authorization')!.replace(/^Bearer\s+/i, '').trim());

  r.get('/doorbell', (req, res) => {
    allowed(req.identity!, 'doorbell.write', req.header('authorization'));
    res.set('Cache-Control', 'no-store').json(doorbell.status(credentialHash(req)));
  });

  r.post('/doorbell/ack', (req, res) => {
    allowed(req.identity!, 'doorbell.write', req.header('authorization'));
    if (!doorbell.acknowledge(req.body?.probe_token, credentialHash(req))) {
      return void res.status(400).json({ error: 'invalid or expired setup probe' });
    }
    res.json({ ok: true, ...doorbell.status(credentialHash(req)) });
  });

  // The Business bot registers its own wake-up webhook (e.g. a Grok Bot routine), so its key never
  // has to pass through a human. Only HTTPS hosts on the allowlist; the key is never echoed or logged.
  r.post('/doorbell', async (req, res) => {
    const { url, key, test } = req.body ?? {};
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      return void res.status(400).json({ error: 'url is not a valid URL' });
    }
    const host = parsed.hostname.toLowerCase();
    const local = host === '127.0.0.1' || host === 'localhost';
    if (!cfg.pushHostAllowlist.includes(host) || parsed.username || parsed.password || parsed.hash ||
      (local ? !['http:', 'https:'].includes(parsed.protocol) : parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443'))) {
      return void res.status(400).json({ error: `host ${host} not allowed (allowed: ${cfg.pushHostAllowlist.join(', ')}, https only)` });
    }
    if (typeof key !== 'string' || key.length < 8 || key.length > 512) {
      return void res.status(400).json({ error: 'key is required (the webhook bearer key)' });
    }
    allowed(req.identity!, 'doorbell.write', req.header('authorization'));
    doorbell.configure({ url: parsed.toString(), key, identity: req.identity }, credentialHash(req));
    db.logEvent({ actor: req.identity!.id, kind: 'doorbell_configured', detail: { host } });
    const ring = test ? await doorbell.testRing(credentialHash(req)) : undefined;
    allowed(req.identity!, 'doorbell.write', req.header('authorization'));
    res.json({ ok: true, host, ...(ring ? { test_ring: ring } : {}), wakeup: doorbell.status(credentialHash(req)) });
  });

  r.delete('/doorbell', (req, res) => {
    allowed(req.identity!, 'doorbell.write', req.header('authorization'));
    doorbell.clear();
    db.logEvent({ actor: req.identity!.id, kind: 'doorbell_cleared' });
    res.json({ ok: true });
  });

  r.get('/tasks/:taskId', async (req, res) => {
    allowed(req.identity!, 'tasks.read', req.header('authorization'));
    const row = db.sqlite.prepare(`SELECT owner FROM work_items WHERE task_id = ? AND business_id = ? LIMIT 1`).get(req.params.taskId, db.businessId) as
      | { owner: string }
      | undefined;
    const task = row ? await executor.loadForOwner(row.owner, req.params.taskId) : undefined;
    allowed(req.identity!, 'tasks.read', req.header('authorization'));
    if (!task) return void res.status(404).json({ error: 'unknown task' });
    res.json({ task_id: task.id, state: stateName(task.status?.state), history: conversation(task).map(summarizeMessage) });
  });

  r.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof RelayAuthorizationError) return void res.status(403).json({ error: error.message });
    if (error instanceof RelayLeaseError) return void res.status(409).json({ error: error.message });
    next(error);
  });
  return r;
}

/** History plus the latest status message, de-duplicated, oldest first. */
function conversation(task: Task) {
  const msgs = [...(task.history ?? [])];
  const last = task.status?.message;
  if (last && !msgs.some((m) => m.messageId === last.messageId)) msgs.push(last);
  return msgs;
}
