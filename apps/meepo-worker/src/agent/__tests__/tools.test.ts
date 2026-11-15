import { WORKER_CHANNEL_METHODS, type Timing } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { buildCronTools, buildMemoryTools, buildTicketTools } from '../tools.js';

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

  it('CronCreate converts an ISO time with an offset to the epoch milliseconds the server stores', async () => {
    const { rpc, calls } = rpcRecorder({
      id: 'sched-1',
      nextFireAt: 1_794_877_200_000,
      createdAt: 0,
    });
    const cronCreate = buildCronTools(rpc, 'sess-1', 'Asia/Shanghai').find(
      (tool) => tool.name === 'CronCreate'
    )!;

    const result = await cronCreate.execute('call-1', {
      prompt: 'Standup',
      timing: { kind: 'at', at: '2026-11-17T09:00:00+08:00' },
    });

    expect(calls[0].params).toMatchObject({ timing: { kind: 'at', at: 1_794_877_200_000 } });
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('"nextFireAtLocal": "2026-11-17T09:00:00+08:00"');
  });

  it('CronCreate rejects an ISO time without an offset before calling the server', async () => {
    const { rpc, calls } = rpcRecorder();
    const cronCreate = buildCronTools(rpc, 'sess-1').find((tool) => tool.name === 'CronCreate')!;

    await expect(
      cronCreate.execute('call-1', {
        prompt: 'Standup',
        timing: { kind: 'at', at: '2026-11-17T09:00:00' },
      })
    ).rejects.toThrow('UTC offset');
    expect(calls).toEqual([]);
  });

  it('CronList shows each instant next to its epoch value in the session timezone', async () => {
    const { rpc } = rpcRecorder([
      {
        id: 'sched-1',
        action: 'resume_session',
        timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
        nextFireAt: 1_794_877_200_000,
        createdAt: 1_794_800_000_000,
        lastFiredAt: 1_794_790_800_000,
      },
      {
        id: 'sched-2',
        action: 'resume_session',
        timing: { kind: 'at', at: 1 },
        nextFireAt: null,
        createdAt: 1_794_800_000_000,
      },
    ]);
    const cronList = buildCronTools(rpc, 'sess-1', 'Asia/Shanghai').find(
      (tool) => tool.name === 'CronList'
    )!;

    const result = await cronList.execute('call-1', {});
    const jobs = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '[]');

    expect(jobs[0]).toMatchObject({
      nextFireAt: 1_794_877_200_000,
      nextFireAtLocal: '2026-11-17T09:00:00+08:00',
      createdAtLocal: '2026-11-16T11:33:20+08:00',
      lastFiredAtLocal: '2026-11-16T09:00:00+08:00',
    });
    expect(jobs[1].nextFireAt).toBeNull();
    expect(jobs[1].nextFireAtLocal).toBeUndefined();
  });

  it('TicketCreate accepts the same ISO time for a scheduled ticket', async () => {
    const { rpc, calls } = rpcRecorder({
      kind: 'schedule',
      schedule: { id: 's', nextFireAt: 1_794_877_200_000, createdAt: 0 },
    });
    const [tool] = buildTicketTools(rpc, 'sess-1', 'Asia/Shanghai');

    const result = await tool.execute('call-1', {
      objective: 'Audit',
      timing: { kind: 'at', at: '2026-11-17T01:00:00Z' },
    });

    expect(calls[0].params).toMatchObject({ timing: { kind: 'at', at: 1_794_877_200_000 } });
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('"nextFireAtLocal": "2026-11-17T09:00:00+08:00"');
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

describe('buildMemoryTools', () => {
  const read = (rpc: (method: string, params: unknown) => Promise<unknown>) => {
    const tool = buildMemoryTools(rpc, { sessionId: 's1' }).find((t) => t.name === 'MemoryRead');
    if (!tool) throw new Error('MemoryRead missing');
    return tool;
  };

  it('answers a read of a missing entry as data, not as a tool failure', async () => {
    const tool = read(() =>
      Promise.reject(new Error('[not_found] memory project/x does not exist'))
    );
    const result = await tool.execute('call', { path: 'project/x' });
    expect(JSON.stringify(result)).toContain('\\"found\\": false');
    expect(JSON.stringify(result)).toContain('does not exist');
  });

  it('still fails reads on other errors and keeps not_found a failure for writes', async () => {
    await expect(
      read(() => Promise.reject(new Error('[forbidden] nope'))).execute('call', { path: 'p' })
    ).rejects.toThrow('forbidden');
    const write = buildMemoryTools(() => Promise.reject(new Error('[not_found] x')), {
      sessionId: 's1',
    }).find((t) => t.name === 'MemoryWrite');
    await expect(
      write?.execute('call', {
        path: 'p',
        description: 'd',
        content: 'c',
        expected_revision: 0,
      })
    ).rejects.toThrow('not_found');
  });
});
