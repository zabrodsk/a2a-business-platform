import { createHash } from 'node:crypto';
import { TaskState, type Message, type Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationSender,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { agentMessage, stateName, summarizeMessage } from './a2a-helpers.js';
import { identityAllowed, RelayUser } from './auth.js';
import type { AcceptedReply, Config, Identity } from './config.js';
import type { RelayDb, WorkItem } from './db.js';
import type { Doorbell } from './doorbell.js';

export interface Reply {
  state: TaskState;
  message?: Message;
}

interface Waiter {
  taskId: string;
  resolve: (reply: Reply | null) => void;
}

/**
 * The A2A side of the relay. The real agent is the Business GrokBot, which is not an
 * HTTP server; so each customer turn becomes a work item in our private inbox, and the
 * A2A task stays WORKING until the bot replies. The SDK's blocking SendMessage then
 * returns as soon as the task reaches INPUT_REQUIRED or a terminal state.
 */
export class RelayExecutor implements AgentExecutor {
  private readonly waiters = new Map<string, Waiter>();
  private replayPromise?: Promise<void>;
  private replayTimer?: NodeJS.Timeout;

  startRecovery() {
    this.hydrateAcceptedReplies();
    void this.replayReplies();
    this.replayTimer = setInterval(() => void this.replayReplies(), 500);
    this.replayTimer.unref();
  }

  async stopRecovery() {
    if (this.replayTimer) clearInterval(this.replayTimer);
    for (const waiter of [...this.waiters.values()]) waiter.resolve(null);
    await this.replayPromise;
  }

  /** Cross-DB recovery is synchronous before claiming: accepted work cannot be offered again. */
  hydrateAcceptedReplies() {
    for (const record of this.cfg.pendingReplies?.() ?? []) {
      if (record.business_id === this.db.businessId) this.db.storeAcceptedReply(record);
    }
  }

  replayReplies(): Promise<void> {
    if (!this.replayPromise) {
      this.replayPromise = this.recoverReplies().finally(() => { this.replayPromise = undefined; });
    }
    return this.replayPromise;
  }

  private async recoverReplies() {
    try {
      this.hydrateAcceptedReplies();
      for (const record of this.db.pendingReplies()) {
        if (this.waiters.has(record.work_item_id)) continue;
        const item = this.db.getWorkItem(record.work_item_id);
        if (item) await this.applyStoredReply(item, record.reply);
      }
    } catch (error) {
      this.db.logEvent({ actor: 'relay', kind: 'reply_recovery_pending', detail: { error: String(error) } });
    }
  }

  /** Applied by every SDK save, closing the live-bus/late-save crash window. */
  overlayAcceptedReplies(task: Task) {
    const accepted = this.db.latestAcceptedReplyForTask(task.id);
    const progress = task.status?.state === TaskState.TASK_STATE_SUBMITTED || task.status?.state === TaskState.TASK_STATE_WORKING;
    const laterDecision = accepted?.delivered && !progress && task.status?.message?.messageId !== accepted.record.message_id;
    if (accepted && !laterDecision) {
      mergeReply(task, accepted.record.reply, true);
    }
  }

  markPersistedReplies(task: Task, incomingMessageId: string | undefined) {
    for (const record of this.db.pendingReplies()) {
      if (record.task_id === task.id && incomingMessageId === record.message_id && containsReply(task, record.message_id)) {
        // Authority acknowledgement first: if that fails the local outbox remains retryable.
        try {
          this.cfg.markReplyDelivered?.(record.work_item_id);
          this.db.markReplyDelivered(record.work_item_id);
        } catch (error) {
          this.db.logEvent({ actor: 'relay', kind: 'reply_acknowledgement_pending', detail: { work_item_id: record.work_item_id, error: String(error) } });
        }
      }
    }
  }

  constructor(
    private readonly cfg: Config,
    private readonly db: RelayDb,
    private readonly doorbell: Doorbell,
    private readonly taskStore: TaskStore,
    private readonly pushSender: PushNotificationSender,
  ) {}

  execute = async (rc: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId, userMessage } = rc;
    const caller = rc.context.user instanceof RelayUser ? rc.context.user.identity : undefined;
    if (caller && !identityAllowed(this.cfg, caller, 'a2a')) throw new Error('customer authorization was revoked');
    if (this.cfg.isActive?.() === false) throw new Error('business relay is not active');
    const owner = rc.context.user?.userName ?? 'unknown';
    const identity = rc.context.user instanceof RelayUser ? rc.context.user.identity : undefined;
    const summary = {
      ...summarizeMessage(userMessage),
      authenticated_sender: {
        agent_id: owner,
        acting_for: identity?.customer_id ? { type: 'customer', id: identity.customer_id } : null,
      },
    };
    const now = () => new Date().toISOString();

    const task: Task = rc.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: {},
    };
    bus.publish(AgentEvent.task(task));
    this.db.logEvent({
      task_id: taskId,
      actor: owner,
      kind: rc.task ? 'customer_message' : 'task_created',
      detail: summary,
    });

    const status = (state: TaskState, message?: Message) =>
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state, message, timestamp: now() }, metadata: {} }));

    const agentTurns = this.db.countRepliesForTask(taskId);
    if (agentTurns >= this.cfg.maxAgentTurns) {
      const msg = agentMessage(taskId, contextId, `Turn limit of ${this.cfg.maxAgentTurns} agent messages reached. Escalated to a human.`);
      status(TaskState.TASK_STATE_FAILED, msg);
      this.db.logEvent({ task_id: taskId, actor: 'relay', kind: 'turn_limit', detail: { agentTurns } });
      return;
    }

    status(TaskState.TASK_STATE_WORKING);
    const item = this.db.createWorkItem({
      task_id: taskId,
      context_id: contextId,
      owner,
      customer_message_id: userMessage.messageId,
      message_json: JSON.stringify(summary),
    });
    if (item.status === 'done' && item.reply_json) {
      const accepted = JSON.parse(item.reply_json) as Reply;
      if (accepted.message) status(accepted.state, accepted.message);
      return;
    }
    this.doorbell.ring('new_message');

    const reply = await new Promise<Reply | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(item.id);
        resolve(null);
      }, this.cfg.replyWaitMs);
      timer.unref();
      this.waiters.set(item.id, {
        taskId,
        resolve: (r) => {
          clearTimeout(timer);
          this.waiters.delete(item.id);
          resolve(r);
        },
      });
    });

    if (!reply) {
      // Task stays WORKING; a late reply is applied straight to the store (applyStoredReply).
      this.db.logEvent({ task_id: taskId, actor: 'relay', kind: 'reply_wait_timeout', detail: { work_item: item.id } });
      return;
    }
    if (reply.state === TaskState.TASK_STATE_COMPLETED && reply.message) {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: resultArtifact(reply.message),
          append: false,
          lastChunk: true,
          metadata: {},
        }),
      );
    }
    status(reply.state, reply.message);
  };

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    this.db.cancelOpenItemsForTask(taskId);
    let resolved = false;
    for (const w of [...this.waiters.values()]) {
      if (w.taskId === taskId) {
        w.resolve({ state: TaskState.TASK_STATE_CANCELED });
        resolved = true;
      }
    }
    if (!resolved) {
      const t = await this.loadAnyOwner(taskId);
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: t?.contextId ?? '',
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
          metadata: {},
        }),
      );
    }
    this.db.logEvent({ task_id: taskId, actor: 'relay', kind: 'task_canceled' });
  };

  /**
   * Called by the private bot API. Exactly one reply per work item; repeats are reported as duplicates.
   */
  async submitReply(item: WorkItem, reply: Reply, actor: Identity | string,
    lease?: { token: unknown; generation: unknown }): Promise<'live' | 'stored' | 'duplicate'> {
    const identity: Identity = typeof actor === 'string' ? { id: actor, role: 'business' } : actor;
    // No awaits between these checks and both durable acceptances (single authoritative process).
    if (!identityAllowed(this.cfg, identity, 'inbox.reply')) throw new RelayAuthorizationError();
    this.hydrateAcceptedReplies();
    const current = this.db.getWorkItem(item.id);
    if (!current || current.status === 'cancelled') throw new RelayLeaseError();
    if (current.status === 'done') return 'duplicate';
    if (this.cfg.businessId && !this.db.validLease(current, identity, lease?.token, lease?.generation)) {
      throw new RelayLeaseError();
    }
    if (reply.message) reply.message.messageId = stableId(`reply:${item.id}`);
    let record: AcceptedReply = {
      work_item_id: item.id, task_id: item.task_id, context_id: item.context_id, owner: item.owner,
      business_id: this.db.businessId, connection_id: identity.connection_id,
      execution_epoch: identity.execution_epoch, message_id: reply.message?.messageId ?? stableId(`reply:${item.id}`), reply,
    };
    record = this.cfg.acceptReply?.(record, identity) ?? record;
    this.db.storeAcceptedReply(record);
    this.db.logEvent({
      task_id: item.task_id, actor: identity.id, kind: 'business_reply',
      detail: { state: stateName(record.reply.state), ...(record.reply.message ? summarizeMessage(record.reply.message) : {}) },
    });
    const waiter = this.waiters.get(item.id);
    if (waiter) {
      waiter.resolve(record.reply);
      return 'live';
    }
    await this.applyStoredReply(item, record.reply);
    return 'stored';
  }

  /** Late or recovered replies are idempotent in the SDK task store, including artifacts. */
  private async applyStoredReply(item: WorkItem, reply: Reply) {
    const ctx = ownerContext(item.owner);
    const task = await this.taskStore.load(item.task_id, ctx);
    if (!task) throw new Error(`task ${item.task_id} not found for owner ${item.owner}`);
    const existed = reply.message && containsReply(task, reply.message.messageId);
    mergeReply(task, reply);
    await this.taskStore.save(task, ctx);
    this.markPersistedReplies(task, reply.message?.messageId);
    if (!existed) {
      await this.pushSender.send(
        { payload: { $case: 'statusUpdate', value: { taskId: task.id, contextId: task.contextId, status: task.status, metadata: {} } } },
        ctx, task,
      );
    }
  }

  /** Loads a task for the bot inbox, which acts on behalf of the task's owner. */
  loadForOwner(owner: string, taskId: string) {
    return this.taskStore.load(taskId, ownerContext(owner));
  }

  private async loadAnyOwner(taskId: string): Promise<Task | undefined> {
    const row = this.db.sqlite.prepare(`SELECT owner FROM work_items WHERE task_id = ? AND business_id = ? LIMIT 1`).get(taskId, this.db.businessId) as
      | { owner: string }
      | undefined;
    return row ? this.loadForOwner(row.owner, taskId) : undefined;
  }
}

export function ownerContext(owner: string) {
  return new ServerCallContext({ user: new RelayUser({ id: owner, role: 'customer' }) });
}

function resultArtifact(message: Message) {
  return {
    artifactId: stableId(`artifact:${message.messageId}`),
    name: 'result',
    description: 'Final answer from the Pneu 007 agent.',
    parts: message.parts,
    metadata: {},
    extensions: [],
  };
}

export class RelayAuthorizationError extends Error {
  constructor() { super('connection is no longer authorized'); }
}
export class RelayLeaseError extends Error {
  constructor() { super('claim lease is missing, expired or belongs to another connection'); }
}
function containsReply(task: Task, messageId: string) {
  return task.status?.message?.messageId === messageId || task.history.some((m) => m.messageId === messageId);
}
function mergeReply(task: Task, reply: Reply, force = false) {
  if (!force && reply.message && containsReply(task, reply.message.messageId)) return;
  if (task.status?.message && !task.history.some((m) => m.messageId === task.status!.message!.messageId)) {
    task.history.push(task.status.message);
  }
  task.status = { state: reply.state, message: reply.message, timestamp: new Date().toISOString() };
  if (reply.message && !task.history.some((m) => m.messageId === reply.message!.messageId)) task.history.push(reply.message);
  if (reply.state === TaskState.TASK_STATE_COMPLETED && reply.message) {
    const artifact = resultArtifact(reply.message);
    if (!task.artifacts.some((a) => a.artifactId === artifact.artifactId)) task.artifacts.push(artifact);
  }
}
function stableId(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
