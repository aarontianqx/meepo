import { WORKER_CHANNEL_METHODS, type Timing } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { buildCronTools, buildTicketTools } from '../tools.js';

interface RpcCall {
  method: string;
  params: unknown;
}

function rpcRecorder(result: unknown = {}) {
  const calls: RpcCall[] = [];
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    return Promise.resolve(result);
  };
  return { rpc, calls };
}

describe('buildTicketTools', () => {
  it('exposes a single TicketCreate tool with the documented boundary', () => {
    const { rpc } = rpcRecorder();
    const tools = buildTicketTools(rpc, 'sess-1');
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('TicketCreate');
    expect(tool.description).toContain('fresh context');
    expect(tool.description).toContain('CronCreate');
  });

  it('injects sessionId and forwards objective/contextSummary/requiredTags/timing', async () => {
    const { rpc, calls } = rpcRecorder({ kind: 'ticket', ticket: { id: 't-1' } });
    const [tool] = buildTicketTools(rpc, 'sess-1');
    const timing: Timing = { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' };

    const result = await tool.execute('call-1', {
      objective: 'Nightly dependency audit',
      contextSummary: 'Focus on prod deps',
      requiredTags: ['gpu-less'],
      timing,
    });

    expect(calls).toEqual([
      {
        method: WORKER_CHANNEL_METHODS.ticketCreate,
        params: {
          sessionId: 'sess-1',
          objective: 'Nightly dependency audit',
          contextSummary: 'Focus on prod deps',
          requiredTags: ['gpu-less'],
          timing,
        },
      },
    ]);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('"id": "t-1"');
  });

  it('supports immediate tickets without timing', async () => {
    const { rpc, calls } = rpcRecorder();
    const [tool] = buildTicketTools(rpc, 'sess-1');

    await tool.execute('call-1', { objective: 'Refactor the parser' });

    expect(calls[0].params).toEqual({ sessionId: 'sess-1', objective: 'Refactor the parser' });
  });

  it('throws when the rpc fails', async () => {
    const rpc = () => Promise.reject(new Error('server unavailable'));
    const [tool] = buildTicketTools(rpc, 'sess-1');

    await expect(tool.execute('call-1', { objective: 'x' })).rejects.toThrow('server unavailable');
  });
});

describe('buildCronTools', () => {
  it('CronCreate forwards prompt + timing with the sessionId injected', async () => {
    const { rpc, calls } = rpcRecorder({ id: 'sched-1' });
    const tools = buildCronTools(rpc, 'sess-1');
    const cronCreate = tools.find((tool) => tool.name === 'CronCreate');
    expect(cronCreate).toBeDefined();

    await cronCreate!.execute('call-1', {
      prompt: 'Standup summary',
      timing: { kind: 'at', at: 1_700_000_000_000 },
    });

    expect(calls).toEqual([
      {
        method: WORKER_CHANNEL_METHODS.cronCreate,
        params: {
          sessionId: 'sess-1',
          prompt: 'Standup summary',
          timing: { kind: 'at', at: 1_700_000_000_000 },
        },
      },
    ]);
  });

  it('CronDelete takes scheduleId', async () => {
    const { rpc, calls } = rpcRecorder({ deleted: true });
    const tools = buildCronTools(rpc, 'sess-1');
    const cronDelete = tools.find((tool) => tool.name === 'CronDelete');

    await cronDelete!.execute('call-1', { scheduleId: 'sched-1' });

    expect(calls).toEqual([
      {
        method: WORKER_CHANNEL_METHODS.cronDelete,
        params: { sessionId: 'sess-1', scheduleId: 'sched-1' },
      },
    ]);
  });
});
