import express, { type Router } from 'express';
import type { Task } from '@a2a-js/sdk';
import { agentMessage, REPLY_STATES, stateName, summarizeMessage, type ReplyStateName } from './a2a-helpers.js';
import { requireRole } from './auth.js';
import type { Config } from './config.js';
import type { RelayDb, WorkItem } from './db.js';
import type { Doorbell } from './doorbell.js';
import type { RelayExecutor } from './executor.js';

// Private API for the Business GrokBot. This is NOT A2A; it is the inbox behind
// the public A2A endpoint (scope-of-work §6.4, §7.1).

const MAX_TEXT = 8000;
const MAX_DATA_BYTES = 32_000;

export function botRouter(cfg: Config, db: RelayDb, doorbell: Doorbell, executor: RelayExecutor): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.use(requireRole(cfg, 'business'));

  const view = async (item: WorkItem) => {
    const task = await executor.loadForOwner(item.owner, item.task_id);
    const history = task ? conversation(task).map(summarizeMessage) : [];
    if (!history.some((m) => m.message_id === item.customer_message_id)) history.push(JSON.parse(item.message_json));
    return {
      work_item_id: item.id,
      task_id: item.task_id,
      context_id: item.context_id,
      customer: item.owner,
      turn: db.countRepliesForTask(item.task_id) + 1,
      max_turns: cfg.maxAgentTurns,
      history,
      reply_with: `POST /bot/reply {"work_item_id":"${item.id}","text":"...","state":"input-required|completed|rejected"}`,
    };
  };

  const claim = async (actor: string) => {
    const items = db.claimAvailable(cfg.leaseMs);
    for (const i of items) db.logEvent({ task_id: i.task_id, actor, kind: 'work_claimed', detail: { work_item: i.id } });
    return Promise.all(items.map(view));
  };

  // Claim everything pending. Claimed items come back after LEASE_MS if not answered.
  r.get('/inbox', async (req, res) => {
    res.json({ items: await claim(req.identity!.id) });
  });

  // Long-poll: returns as soon as something is pending, or empty after `timeout` seconds (max 55).
  r.get('/wait', async (req, res) => {
    const timeoutMs = Math.min(Number(req.query.timeout ?? 50), 55) * 1000;
    if (db.countAvailable(cfg.leaseMs) === 0) {
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
    res.json({ items: await claim(req.identity!.id) });
  });

  r.post('/reply', async (req, res) => {
    const { work_item_id, text, data, state } = req.body ?? {};
    if (typeof work_item_id !== 'string') return void res.status(400).json({ error: 'work_item_id is required' });
    if (typeof text !== 'string' || !text.trim()) return void res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_TEXT) return void res.status(400).json({ error: `text longer than ${MAX_TEXT} chars` });
    if (data !== undefined && JSON.stringify(data).length > MAX_DATA_BYTES) {
      return void res.status(400).json({ error: `data larger than ${MAX_DATA_BYTES} bytes` });
    }
    const stateKey = (state ?? 'input-required') as ReplyStateName;
    if (!(stateKey in REPLY_STATES)) {
      return void res.status(400).json({ error: `state must be one of ${Object.keys(REPLY_STATES).join(', ')}` });
    }
    const item = db.getWorkItem(work_item_id);
    if (!item) return void res.status(404).json({ error: 'unknown work_item_id' });
    if (item.status === 'cancelled') return void res.status(409).json({ error: 'task was canceled by the customer' });

    const message = agentMessage(item.task_id, item.context_id, text, data);
    const outcome = await executor.submitReply(item, { state: REPLY_STATES[stateKey], message }, req.identity!.id);
    if (outcome === 'duplicate') {
      return void res.status(200).json({ ok: true, duplicate: true, note: 'this work item was already answered' });
    }
    res.json({ ok: true, task_id: item.task_id, state: stateKey, delivered: outcome });
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
    if (!cfg.pushHostAllowlist.includes(host) || (parsed.protocol !== 'https:' && !local)) {
      return void res.status(400).json({ error: `host ${host} not allowed (allowed: ${cfg.pushHostAllowlist.join(', ')}, https only)` });
    }
    if (typeof key !== 'string' || key.length < 8 || key.length > 512) {
      return void res.status(400).json({ error: 'key is required (the webhook bearer key)' });
    }
    db.setSetting('business_webhook', JSON.stringify({ url: parsed.toString(), key }));
    db.logEvent({ actor: req.identity!.id, kind: 'doorbell_configured', detail: { host, path: parsed.pathname } });
    const ring = test ? await doorbell.testRing() : undefined;
    res.json({ ok: true, host, ...(ring ? { test_ring: ring } : {}) });
  });

  r.delete('/doorbell', (req, res) => {
    db.setSetting('business_webhook', undefined);
    db.logEvent({ actor: req.identity!.id, kind: 'doorbell_cleared' });
    res.json({ ok: true });
  });

  r.get('/tasks/:taskId', async (req, res) => {
    const row = db.sqlite.prepare(`SELECT owner FROM work_items WHERE task_id = ? LIMIT 1`).get(req.params.taskId) as
      | { owner: string }
      | undefined;
    const task = row ? await executor.loadForOwner(row.owner, req.params.taskId) : undefined;
    if (!task) return void res.status(404).json({ error: 'unknown task' });
    res.json({ task_id: task.id, state: stateName(task.status?.state), history: conversation(task).map(summarizeMessage) });
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
