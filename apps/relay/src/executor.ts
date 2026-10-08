import { randomUUID } from 'node:crypto';
import { TaskState, type Message, type Task, type TaskStatus } from '@a2a-js/sdk';
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
import { RelayUser } from './auth.js';
import type { Config } from './config.js';
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

  constructor(
    private readonly cfg: Config,
    private readonly db: RelayDb,
    private readonly doorbell: Doorbell,
    private readonly taskStore: TaskStore,
    private readonly pushSender: PushNotificationSender,
  ) {}

  execute = async (rc: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId, userMessage } = rc;
    const owner = rc.context.user?.userName ?? 'unknown';
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
      detail: summarizeMessage(userMessage),
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
      message_json: JSON.stringify(summarizeMessage(userMessage)),
    });
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
  async submitReply(item: WorkItem, reply: Reply, actor: string): Promise<'live' | 'stored' | 'duplicate'> {
    if (!this.db.completeWorkItem(item.id, { state: stateName(reply.state), message_id: reply.message?.messageId })) {
      return 'duplicate';
    }
    this.db.logEvent({
      task_id: item.task_id,
      actor,
      kind: 'business_reply',
      detail: { state: stateName(reply.state), ...(reply.message ? summarizeMessage(reply.message) : {}) },
    });
    const waiter = this.waiters.get(item.id);
    if (waiter) {
      waiter.resolve(reply);
      return 'live';
    }
    await this.applyStoredReply(item, reply);
    return 'stored';
  }

  /** Fallback when no executor is waiting (wait timed out, or the relay restarted). */
  private async applyStoredReply(item: WorkItem, reply: Reply) {
    const ctx = ownerContext(item.owner);
    const task = await this.taskStore.load(item.task_id, ctx);
    if (!task) throw new Error(`task ${item.task_id} not found for owner ${item.owner}`);
    const status: TaskStatus = { state: reply.state, message: reply.message, timestamp: new Date().toISOString() };
    if (task.status?.message && !task.history.some((m) => m.messageId === task.status!.message!.messageId)) {
      task.history.push(task.status.message);
    }
    task.status = status;
    if (reply.state === TaskState.TASK_STATE_COMPLETED && reply.message) task.artifacts.push(resultArtifact(reply.message));
    await this.taskStore.save(task, ctx);
    await this.pushSender.send(
      { payload: { $case: 'statusUpdate', value: { taskId: task.id, contextId: task.contextId, status, metadata: {} } } },
      ctx,
      task,
    );
  }

  /** Loads a task for the bot inbox, which acts on behalf of the task's owner. */
  loadForOwner(owner: string, taskId: string) {
    return this.taskStore.load(taskId, ownerContext(owner));
  }

  private async loadAnyOwner(taskId: string): Promise<Task | undefined> {
    const row = this.db.sqlite.prepare(`SELECT owner FROM work_items WHERE task_id = ? LIMIT 1`).get(taskId) as
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
    artifactId: randomUUID(),
    name: 'result',
    description: 'Final answer from the Pneu 007 agent.',
    parts: message.parts,
    metadata: {},
    extensions: [],
  };
}
