import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai';
import type { WorkerStreamEvent } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import {
  SessionRunner,
  mergeQueuedTurns,
  type RunnerAgent,
  type SessionCompactor,
} from '../session-runner.js';

function assistantMessage(text: string, stopReason: StopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function userMessage(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 0 };
}

class FakeAgent implements RunnerAgent {
  private listeners: Array<(event: AgentEvent) => void> = [];
  private resolvers: Array<() => void> = [];
  readonly prompts: string[] = [];
  readonly steered: AgentMessage[] = [];
  readonly state: { messages: AgentMessage[] } = { messages: [] };
  abortCount = 0;

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  prompt(input: string): Promise<void> {
    this.prompts.push(input);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  steer(message: AgentMessage): void {
    this.steered.push(message);
  }

  abort(): void {
    this.abortCount += 1;
    this.finishRun();
  }

  emitEvent(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Simulate the end of the current run (pi resolves prompt() after agent_end). */
  finishRun(): void {
    this.resolvers.shift()?.();
  }
}

function setup(compactor?: SessionCompactor) {
  const agent = new FakeAgent();
  const events: WorkerStreamEvent[] = [];
  const runner = new SessionRunner({
    agent,
    sessionId: 's1',
    workerId: 'w1',
    emit: (event) => events.push(event),
    compactor,
  });
  return { agent, events, runner };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('SessionRunner', () => {
  it('runs wait-delivery turns serially and reports completion with summary and usage', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    runner.runTurn('t2', 'p2', 'wait');
    expect(agent.prompts).toEqual(['p1']);

    agent.emitEvent({ type: 'message_start', message: userMessage('p1') });
    agent.emitEvent({
      type: 'message_update',
      message: assistantMessage('ans'),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'ans',
        partial: assistantMessage('ans'),
      },
    });
    agent.emitEvent({ type: 'message_end', message: assistantMessage('answer 1') });
    agent.finishRun();
    await flush();

    expect(agent.prompts).toEqual(['p1', 'p2']);
    expect(events).toContainEqual({
      type: 'run_started',
      runId: 't1',
      workerId: 'w1',
      sessionId: 's1',
      ticketId: undefined,
    });
    expect(events).toContainEqual({ type: 'text_delta', runId: 't1', delta: 'ans' });
    expect(events).toContainEqual({
      type: 'run_completed',
      runId: 't1',
      resultSummary: 'answer 1',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(events).toContainEqual({
      type: 'run_started',
      runId: 't2',
      workerId: 'w1',
      sessionId: 's1',
      ticketId: undefined,
    });

    agent.emitEvent({ type: 'message_start', message: userMessage('p2') });
    agent.emitEvent({ type: 'message_end', message: assistantMessage('answer 2') });
    agent.finishRun();
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_completed', runId: 't2' }));
  });

  it('drops if_idle turns while busy', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    runner.runTurn('t2', 'p2', 'if_idle');
    expect(agent.prompts).toEqual(['p1']);

    agent.finishRun();
    await flush();

    expect(agent.prompts).toEqual(['p1']);
    expect(events).toContainEqual({ type: 'run_dropped', runId: 't2' });
  });

  it('starts if_idle turns immediately when idle', () => {
    const { agent, runner } = setup();
    runner.runTurn('t1', 'p1', 'if_idle');
    expect(agent.prompts).toEqual(['p1']);
  });

  it('aborts the active tool immediately for urgent delivery and starts a new run', async () => {
    const { agent, events, runner } = setup();
    runner.runTurn('t1', 'p1', 'wait');
    runner.runTurn('t2', 'p2', 'urgent');
    expect(agent.abortCount).toBe(1);
    expect(agent.steered).toEqual([]);
    await flush();
    expect(agent.prompts).toEqual(['p1', 'p2']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run_failed', runId: 't1', code: 'aborted' })
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_started', runId: 't2' }));
    agent.finishRun();
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_completed', runId: 't2' }));
  });

  it('fails a queued task on abort without touching the running turn', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    runner.runTurn('t2', 'p2', 'wait');
    expect(runner.abort('t2')).toBe(true);

    expect(events).toContainEqual({
      type: 'run_failed',
      runId: 't2',
      error: 'aborted before execution',
      code: 'aborted',
    });

    agent.finishRun();
    await flush();
    expect(agent.prompts).toEqual(['p1']);
  });

  it('aborts the running turn through the agent and reports run_failed', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    expect(runner.abort('t1')).toBe(true);
    expect(agent.abortCount).toBe(1);

    await flush();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run_failed', runId: 't1', code: 'aborted' })
    );
  });

  it('reports run_failed when the assistant turn errors', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    const failed = assistantMessage('', 'error');
    failed.errorMessage = 'upstream 500';
    agent.emitEvent({ type: 'message_end', message: failed });
    agent.finishRun();
    await flush();

    expect(events).toContainEqual({
      type: 'run_failed',
      runId: 't1',
      error: 'upstream 500',
      code: 'error',
    });
  });

  it('forwards tool execution events', () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    agent.emitEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    agent.emitEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });

    expect(events).toContainEqual({
      type: 'tool_execution_start',
      runId: 't1',
      toolName: 'bash',
      toolCallId: 'call-1',
      args: { command: 'ls' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_execution_end',
        runId: 't1',
        toolCallId: 'call-1',
        isError: false,
      })
    );
  });
});

describe('mergeQueuedTurns', () => {
  it('returns undefined for an empty queue', () => {
    expect(mergeQueuedTurns([])).toBeUndefined();
  });

  it('passes a single turn through unchanged', () => {
    const turn = { runId: 't1', prompt: 'p1', timeoutSeconds: 30 };
    expect(mergeQueuedTurns([turn])).toBe(turn);
  });

  it('merges multiple turns, annotating each prompt and taking the first runId', () => {
    const merged = mergeQueuedTurns([
      { runId: 't1', prompt: '[Alice] first' },
      { runId: 't2', prompt: '[Bob] second' },
      { runId: 't3', prompt: 'third', timeoutSeconds: 60 },
    ]);
    expect(merged).toEqual({
      images: [],
      runId: 't1',
      timeoutSeconds: undefined,
      prompt: '[1/3] [Alice] first\n\n[2/3] [Bob] second\n\n[3/3] third',
    });
  });
});

describe('SessionRunner queue merging', () => {
  it('merges consecutive wait turns into one execution attributed to the first runId', async () => {
    const { agent, events, runner } = setup();

    runner.runTurn('t1', 'p1', 'wait');
    runner.runTurn('t2', '[Alice] p2', 'wait');
    runner.runTurn('t3', '[Bob] p3', 'wait');
    runner.runTurn('t4', '[Carol] p4', 'wait');
    expect(agent.prompts).toEqual(['p1']);

    agent.finishRun();
    await flush();

    // One merged turn instead of three separate ones.
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toBe('[1/3] [Alice] p2\n\n[2/3] [Bob] p3\n\n[3/3] [Carol] p4');
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_started', runId: 't2' }));
    expect(events).toContainEqual({ type: 'run_merged', runId: 't4', mergedIntoRunId: 't2' });
    expect(events).toContainEqual({ type: 'run_merged', runId: 't3', mergedIntoRunId: 't2' });

    agent.finishRun();
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_completed', runId: 't2' }));
    expect(agent.prompts).toHaveLength(2);
  });
});

describe('SessionRunner compaction', () => {
  function fakeCompactor(overrides: Partial<SessionCompactor> = {}) {
    const calls: AgentMessage[][] = [];
    const compactor: SessionCompactor = {
      estimate: () => 1_000_000,
      shouldCompact: () => true,
      compact: (messages) => {
        calls.push(messages);
        return Promise.resolve([userMessage('SUMMARY')]);
      },
      ...overrides,
    };
    return { compactor, calls };
  }

  it('compacts over-threshold history before prompting', async () => {
    const { compactor, calls } = fakeCompactor();
    const { agent, runner } = setup(compactor);
    agent.state.messages = [userMessage('old 1'), userMessage('old 2')];

    runner.runTurn('t1', 'p1', 'wait');
    await flush();

    expect(calls).toEqual([[userMessage('old 1'), userMessage('old 2')]]);
    expect(agent.state.messages).toEqual([userMessage('SUMMARY')]);
    expect(agent.prompts).toEqual(['p1']);
  });

  it('falls back to keeping the most recent messages when compaction fails', async () => {
    const { compactor } = fakeCompactor({ compact: () => Promise.resolve(undefined) });
    const { agent, runner, events } = setup(compactor);
    agent.state.messages = Array.from({ length: 25 }, (_, i) => userMessage(`m${i}`));

    runner.runTurn('t1', 'p1', 'wait');
    await flush();

    expect(agent.state.messages).toHaveLength(21);
    expect(agent.state.messages[0]).toMatchObject({
      content: expect.stringContaining('上下文已截断'),
    });
    expect(agent.state.messages[1]).toEqual(userMessage('m5'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'context_note' }));
    expect(agent.prompts).toEqual(['p1']);
  });

  it('falls back to truncation when compaction throws', async () => {
    const { compactor } = fakeCompactor({
      compact: () => Promise.reject(new Error('llm down')),
    });
    const { agent, runner } = setup(compactor);
    agent.state.messages = Array.from({ length: 25 }, (_, i) => userMessage(`m${i}`));

    runner.runTurn('t1', 'p1', 'wait');
    await flush();

    expect(agent.state.messages).toHaveLength(21);
    expect(agent.state.messages[0]).toMatchObject({
      content: expect.stringContaining('上下文已截断'),
    });
    expect(agent.prompts).toEqual(['p1']);
  });

  it('leaves history alone below the threshold', async () => {
    const { compactor, calls } = fakeCompactor({ shouldCompact: () => false });
    const { agent, runner } = setup(compactor);
    agent.state.messages = [userMessage('old')];

    runner.runTurn('t1', 'p1', 'wait');
    await flush();

    expect(calls).toHaveLength(0);
    expect(agent.state.messages).toEqual([userMessage('old')]);
  });
});
