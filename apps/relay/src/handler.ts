import { TaskState, type SendMessageRequest, type TaskPushNotificationConfig } from '@a2a-js/sdk';
import { DefaultRequestHandler, type ServerCallContext } from '@a2a-js/sdk/server';
import { PushNotificationNotSupportedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import type { Config } from './config.js';

/**
 * DefaultRequestHandler plus three relay rules:
 * - a customer may only speak when it is their turn (task not SUBMITTED/WORKING),
 * - a re-delivered message (same messageId) returns the current task instead of a second turn,
 * - public push notifications remain disabled, matching the advertised capability.
 */
export class RelayRequestHandler extends DefaultRequestHandler {
  cfg!: Config;

  override async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    const push = params.configuration?.taskPushNotificationConfig;
    if (push) this.checkPushTarget(push);
    const taskId = params.message?.taskId;
    if (taskId) {
      const task = await this.getTask({ id: taskId, tenant: params.tenant ?? '', historyLength: undefined }, context);
      if (task.history?.some((m) => m.messageId === params.message?.messageId)) return task;
      const state = task.status?.state;
      if (state === TaskState.TASK_STATE_SUBMITTED || state === TaskState.TASK_STATE_WORKING) {
        throw new UnsupportedOperationError(
          `Task ${taskId} is waiting for the agent (state ${state === TaskState.TASK_STATE_WORKING ? 'WORKING' : 'SUBMITTED'}). ` +
            'Poll GetTask until it is INPUT_REQUIRED, then send your next message.',
        );
      }
    }
    return super.sendMessage(params, context);
  }

  override async createTaskPushNotificationConfig(params: TaskPushNotificationConfig, context: ServerCallContext) {
    this.checkPushTarget(params);
    return super.createTaskPushNotificationConfig(params, context);
  }

  private checkPushTarget(_cfg: TaskPushNotificationConfig): never {
    throw new PushNotificationNotSupportedError('Public push notifications are not supported.');
  }
}
