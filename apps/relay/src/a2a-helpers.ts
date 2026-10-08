import { randomUUID } from 'node:crypto';
import { Role, TaskState, taskStateToJSON, type Message, type Part } from '@a2a-js/sdk';

export function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

export function dataPart(data: unknown): Part {
  return { content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: 'application/json' };
}

export function agentMessage(taskId: string, contextId: string, text: string, data?: unknown): Message {
  return {
    messageId: randomUUID(),
    taskId,
    contextId,
    role: Role.ROLE_AGENT,
    parts: data === undefined ? [textPart(text)] : [textPart(text), dataPart(data)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Flattens a message into what a chat agent needs to read: who said it, the text, any JSON data. */
export function summarizeMessage(m: Message) {
  const text = m.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : undefined))
    .filter((t): t is string => t !== undefined)
    .join('\n');
  const data = m.parts.filter((p) => p.content?.$case === 'data').map((p) => p.content!.value);
  return {
    message_id: m.messageId,
    from: m.role === Role.ROLE_AGENT ? 'business' : 'customer',
    text,
    ...(data.length ? { data: data.length === 1 ? data[0] : data } : {}),
  };
}

/** Reply states the Business bot may choose. Anything else is rejected at the API boundary. */
export const REPLY_STATES = {
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  rejected: TaskState.TASK_STATE_REJECTED,
  failed: TaskState.TASK_STATE_FAILED,
} as const;
export type ReplyStateName = keyof typeof REPLY_STATES;

export const TERMINAL_STATES: TaskState[] = [
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
];

export const stateName = (s: TaskState | undefined) => (s === undefined ? 'unknown' : taskStateToJSON(s));
