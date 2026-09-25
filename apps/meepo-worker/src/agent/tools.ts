import { Type } from 'typebox';

import { WORKER_CHANNEL_METHODS, type ScheduleView } from '@meepo/protocol';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

/** pi's own tool alias (`Tool` in pi-coding-agent) uses the same `any` schema instantiation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

const timingSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('at'),
    at: Type.Number({ description: 'Unix epoch milliseconds at which to fire once' }),
  }),
  Type.Object({
    kind: Type.Literal('cron'),
    expression: Type.String({ description: '5-field cron expression, e.g. "30 9 * * 1-5"' }),
    timezone: Type.Optional(Type.String({ description: 'IANA timezone, e.g. "Asia/Shanghai"' })),
  }),
]);

const cronCreateSchema = Type.Object({
  prompt: Type.String({ description: 'Prompt injected into this session when the schedule fires' }),
  timing: timingSchema,
});

const cronListSchema = Type.Object({});

const cronDeleteSchema = Type.Object({
  scheduleId: Type.String({ description: 'ID of the schedule to cancel' }),
});

const ticketCreateSchema = Type.Object({
  objective: Type.String({
    description: 'Self-contained objective; the ticket has no access to this conversation',
  }),
  contextSummary: Type.Optional(
    Type.String({ description: 'Extra context the ticket needs to accomplish the objective' })
  ),
  requiredTags: Type.Optional(
    Type.Array(Type.String(), { description: 'Worker tags required to run the ticket' })
  ),
  timing: Type.Optional(timingSchema),
});

function toTextResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: undefined };
}

/**
 * Server-backed schedule tools. The worker keeps no scheduler state; every
 * operation is proxied over the worker channel RPC to the server, which owns
 * schedules scoped to the given session.
 */
export function buildCronTools(rpc: RpcFn, sessionId: string): AnyAgentTool[] {
  const cronCreate: AgentTool<typeof cronCreateSchema> = {
    name: 'CronCreate',
    label: 'Create schedule',
    description:
      "Schedule a future wakeup of THIS session with a prompt, preserving this conversation's " +
      'context. Use timing kind "at" for a one-shot wakeup and kind "cron" for a recurring ' +
      'wakeup. For independent background work that does not need this context, use TicketCreate.',
    parameters: cronCreateSchema,
    execute: async (_toolCallId, params) => {
      const schedule = await rpc(WORKER_CHANNEL_METHODS.cronCreate, { sessionId, ...params });
      return toTextResult(schedule);
    },
  };
  const cronList: AgentTool<typeof cronListSchema> = {
    name: 'CronList',
    label: 'List schedules',
    description: 'List all schedules (wakeups) registered for this session.',
    parameters: cronListSchema,
    execute: async () => {
      const jobs = (await rpc(WORKER_CHANNEL_METHODS.cronList, { sessionId })) as ScheduleView[];
      return toTextResult(jobs);
    },
  };
  const cronDelete: AgentTool<typeof cronDeleteSchema> = {
    name: 'CronDelete',
    label: 'Delete schedule',
    description: 'Cancel a schedule previously created for this session.',
    parameters: cronDeleteSchema,
    execute: async (_toolCallId, params) => {
      const result = await rpc(WORKER_CHANNEL_METHODS.cronDelete, { sessionId, ...params });
      return toTextResult(result);
    },
  };
  return [cronCreate, cronList, cronDelete] as AnyAgentTool[];
}

/**
 * Server-backed ticket tool: creates independent background tasks (optionally
 * scheduled) that run in a fresh context on some worker.
 */
export function buildTicketTools(rpc: RpcFn, sessionId: string): AnyAgentTool[] {
  const ticketCreate: AgentTool<typeof ticketCreateSchema> = {
    name: 'TicketCreate',
    label: 'Create ticket',
    description:
      'Create an independent background task with a self-contained objective (optionally ' +
      'scheduled via timing). It runs in a fresh context with no access to this conversation. ' +
      'Use for heavy multi-step work, PR-producing changes, or recurring audits. In contrast, ' +
      'CronCreate wakes up THIS session and preserves its context.',
    parameters: ticketCreateSchema,
    execute: async (_toolCallId, params) => {
      const result = await rpc(WORKER_CHANNEL_METHODS.ticketCreate, { sessionId, ...params });
      return toTextResult(result);
    },
  };
  return [ticketCreate] as AnyAgentTool[];
}
