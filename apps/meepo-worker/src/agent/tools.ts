import { Type } from 'typebox';

import { WORKER_CHANNEL_METHODS, type CronJobView } from '@meepo/protocol';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

/** pi's own tool alias (`Tool` in pi-coding-agent) uses the same `any` schema instantiation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

const cronCreateSchema = Type.Object({
  cron: Type.String({ description: '5-field cron expression, e.g. "30 9 * * 1-5"' }),
  prompt: Type.String({ description: 'Prompt injected into this session when the job fires' }),
  recurring: Type.Boolean({
    description: 'true to fire on every cron match; false to fire once then auto-delete',
  }),
});

const cronListSchema = Type.Object({});

const cronDeleteSchema = Type.Object({
  jobId: Type.String({ description: 'ID of the cron job to cancel' }),
});

function toTextResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: undefined };
}

/**
 * Server-backed cron tools. The worker keeps no scheduler state; every
 * operation is proxied over the worker channel RPC to the server, which owns
 * cron jobs scoped to the given session.
 */
export function buildCronTools(rpc: RpcFn, sessionId: string): AnyAgentTool[] {
  const cronCreate: AgentTool<typeof cronCreateSchema> = {
    name: 'CronCreate',
    label: 'Create cron job',
    description:
      'Schedule a future wakeup of this session with a prompt. Use a 5-field cron ' +
      'expression; set recurring=false for a one-shot reminder.',
    parameters: cronCreateSchema,
    execute: async (_toolCallId, params) => {
      const job = await rpc(WORKER_CHANNEL_METHODS.cronCreate, { sessionId, ...params });
      return toTextResult(job);
    },
  };
  const cronList: AgentTool<typeof cronListSchema> = {
    name: 'CronList',
    label: 'List cron jobs',
    description: 'List all cron jobs scheduled for this session.',
    parameters: cronListSchema,
    execute: async () => {
      const jobs = (await rpc(WORKER_CHANNEL_METHODS.cronList, { sessionId })) as CronJobView[];
      return toTextResult(jobs);
    },
  };
  const cronDelete: AgentTool<typeof cronDeleteSchema> = {
    name: 'CronDelete',
    label: 'Delete cron job',
    description: 'Cancel a cron job previously created for this session.',
    parameters: cronDeleteSchema,
    execute: async (_toolCallId, params) => {
      const result = await rpc(WORKER_CHANNEL_METHODS.cronDelete, { sessionId, ...params });
      return toTextResult(result);
    },
  };
  return [cronCreate, cronList, cronDelete] as AnyAgentTool[];
}
