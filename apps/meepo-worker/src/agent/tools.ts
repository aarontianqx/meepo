import { Type, type Static } from 'typebox';

import {
  WORKER_CHANNEL_METHODS,
  formatInstant,
  parseInstant,
  type ScheduleView,
  type TicketCreateResult,
  type Timing,
} from '@meepo/protocol';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

/** pi's own tool alias (`Tool` in pi-coding-agent) uses the same `any` schema instantiation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

const timingSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('at'),
    at: Type.Union([Type.String(), Type.Number()], {
      description:
        'When to fire once: an ISO 8601 time with a UTC offset, e.g. "2026-11-17T09:00:00+08:00" ' +
        '(preferred, use the timezone of the times you were shown), or Unix epoch milliseconds',
    }),
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

type TimingInput = Static<typeof timingSchema>;

/** Resolves the model's ISO time to the epoch milliseconds the server stores. */
function toWireTiming(timing: TimingInput): Timing {
  if (timing.kind === 'cron') return timing;
  return { kind: 'at', at: typeof timing.at === 'string' ? parseInstant(timing.at) : timing.at };
}

/** Adds the human-readable instants models cannot compute from epoch milliseconds. */
function withLocalTimes(view: ScheduleView, timezone?: string) {
  const local = (timestamp: number | null | undefined) =>
    typeof timestamp === 'number' ? formatInstant(timestamp, timezone) : undefined;
  return {
    ...view,
    nextFireAtLocal: local(view.nextFireAt),
    createdAtLocal: local(view.createdAt),
    lastFiredAtLocal: local(view.lastFiredAt),
  };
}

function toTextResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: undefined };
}

/**
 * Server-backed schedule tools. The worker keeps no scheduler state; every
 * operation is proxied over the worker channel RPC to the server, which owns
 * schedules scoped to the given session.
 */
export function buildCronTools(rpc: RpcFn, sessionId: string, timezone?: string): AnyAgentTool[] {
  const cronCreate: AgentTool<typeof cronCreateSchema> = {
    name: 'CronCreate',
    label: 'Create schedule',
    description:
      "Schedule a future wakeup of THIS session with a prompt, preserving this conversation's " +
      'context. Use timing kind "at" for a one-shot wakeup and kind "cron" for a recurring ' +
      'wakeup. For independent background work that does not need this context, use TicketCreate.',
    parameters: cronCreateSchema,
    execute: async (_toolCallId, params) => {
      const schedule = (await rpc(WORKER_CHANNEL_METHODS.cronCreate, {
        sessionId,
        prompt: params.prompt,
        timing: toWireTiming(params.timing),
      })) as ScheduleView;
      return toTextResult(withLocalTimes(schedule, timezone));
    },
  };
  const cronList: AgentTool<typeof cronListSchema> = {
    name: 'CronList',
    label: 'List schedules',
    description: 'List all schedules (wakeups) registered for this session.',
    parameters: cronListSchema,
    execute: async () => {
      const jobs = (await rpc(WORKER_CHANNEL_METHODS.cronList, { sessionId })) as ScheduleView[];
      return toTextResult(jobs.map((job) => withLocalTimes(job, timezone)));
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
export function buildTicketTools(rpc: RpcFn, sessionId: string, timezone?: string): AnyAgentTool[] {
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
      const result = (await rpc(WORKER_CHANNEL_METHODS.ticketCreate, {
        sessionId,
        ...params,
        timing: params.timing && toWireTiming(params.timing),
      })) as TicketCreateResult;
      return toTextResult(
        result.kind === 'schedule'
          ? { ...result, schedule: withLocalTimes(result.schedule, timezone) }
          : result
      );
    },
  };
  return [ticketCreate] as AnyAgentTool[];
}

/** Identical memory tools for interactive sessions and independent tickets. */
export function buildMemoryTools(
  rpc: RpcFn,
  scope: { sessionId: string } | { ticketId: string }
): AnyAgentTool[] {
  const path = Type.String({ description: 'Memory path, for example project/payment-retries' });
  const prefix = Type.Optional(Type.String());
  const limit = Type.Optional(Type.Number());
  const definitions = [
    {
      name: 'MemoryList',
      operation: 'list',
      description: 'List current memory metadata, without entry content.',
      schema: Type.Object({ prefix, limit }),
    },
    {
      name: 'MemorySearch',
      operation: 'search',
      description:
        'Search current space memory by literal substring, including Chinese. Returns metadata and bounded snippets.',
      schema: Type.Object({ query: Type.String(), prefix, limit }),
    },
    {
      name: 'MemoryRead',
      operation: 'read',
      description:
        'Read current memory and revision. Optional UTF-8 byte offset/limit or tail; maximum 32 KB.',
      schema: Type.Object({
        path,
        offset: Type.Optional(Type.Number()),
        limit,
        tail: Type.Optional(Type.Number()),
      }),
    },
    {
      name: 'MemoryWrite',
      operation: 'write',
      description:
        'Write curated, durable knowledge. Read first, pass expected_revision to prevent overwriting concurrent edits; 0 creates. Do not store secrets or transient chat.',
      schema: Type.Object({
        path,
        description: Type.String(),
        content: Type.String(),
        keywords: Type.Optional(Type.Array(Type.String())),
        pinned: Type.Optional(Type.Boolean()),
        expected_revision: Type.Number(),
      }),
    },
    {
      name: 'MemoryDelete',
      operation: 'delete',
      description: 'Delete obsolete memory using its current revision.',
      schema: Type.Object({ path, expected_revision: Type.Number() }),
    },
  ];
  return definitions.map((d) => ({
    name: d.name,
    label: d.name,
    description: d.description,
    parameters: d.schema,
    execute: async (_id: string, input: unknown) => {
      try {
        return toTextResult(
          await rpc(WORKER_CHANNEL_METHODS.memory, { ...scope, operation: d.operation, input })
        );
      } catch (error) {
        // A missing entry is an ordinary answer to a read, not a tool failure.
        if (
          d.operation === 'read' &&
          error instanceof Error &&
          error.message.startsWith('[not_found]')
        )
          return toTextResult({ found: false, message: error.message });
        throw error;
      }
    },
  }));
}
