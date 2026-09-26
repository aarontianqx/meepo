import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { WorkerStreamEvent } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { SessionRunner, type RunnerAgent } from '../session-runner.js';
import { SlotSemaphore } from '../slot-semaphore.js';

class FakeAgent implements RunnerAgent {
  private listeners: Array<(event: AgentEvent) => void> = [];
  private resolvers: Array<() => void> = [];
  readonly prompts: string[] = [];
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

  steer(_message: AgentMessage): void {}

  abort(): void {
    this.abortCount += 1;
    this.finishRun();
  }

  finishRun(): void {
    this.resolvers.shift()?.();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeRunner(slots: SlotSemaphore, sessionId: string, events: WorkerStreamEvent[]) {
  const agent = new FakeAgent();
  const runner = new SessionRunner({
    agent,
    sessionId,
    workerId: 'w1',
    emit: (event) => events.push(event),
    slots,
  });
  return { agent, runner };
}

describe('SlotSemaphore', () => {
  it('grants up to maxSlots and wakes waiters in FIFO order', async () => {
    const slots = new SlotSemaphore(1);
    const order: string[] = [];

    await slots.acquire();
    expect(slots.activeCount).toBe(1);
    const second = slots.acquire().then(() => order.push('second'));
    const third = slots.acquire().then(() => order.push('third'));
    expect(slots.waitingCount).toBe(2);

    slots.release();
    await second;
    expect(order).toEqual(['second']);

    slots.release();
    await third;
    expect(order).toEqual(['second', 'third']);
    expect(slots.activeCount).toBe(1);

    slots.release();
    expect(slots.activeCount).toBe(0);
    expect(slots.waitingCount).toBe(0);
  });

  it('rejects non-positive maxSlots', () => {
    expect(() => new SlotSemaphore(0)).toThrow();
  });
});

describe('SessionRunner with a shared SlotSemaphore', () => {
  it('serializes turns from different sessions when maxSlots=1', async () => {
    const events: WorkerStreamEvent[] = [];
    const slots = new SlotSemaphore(1);
    const a = makeRunner(slots, 'sess-a', events);
    const b = makeRunner(slots, 'sess-b', events);

    a.runner.runTurn('ra', 'pa', 'wait');
    await flush();
    expect(a.agent.prompts).toEqual(['pa']);

    b.runner.runTurn('rb', 'pb', 'wait');
    await flush();
    // B holds no slot yet: not started, no run_started event.
    expect(b.agent.prompts).toEqual([]);
    expect(events.some((e) => e.type === 'run_started' && e.runId === 'rb')).toBe(false);

    a.agent.finishRun();
    await flush();
    expect(b.agent.prompts).toEqual(['pb']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run_started', runId: 'rb', sessionId: 'sess-b' })
    );

    b.agent.finishRun();
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_completed', runId: 'rb' }));
  });

  it('runs two sessions in parallel when maxSlots=2 and queues the third', async () => {
    const events: WorkerStreamEvent[] = [];
    const slots = new SlotSemaphore(2);
    const a = makeRunner(slots, 'sess-a', events);
    const b = makeRunner(slots, 'sess-b', events);
    const c = makeRunner(slots, 'sess-c', events);

    a.runner.runTurn('ra', 'pa', 'wait');
    b.runner.runTurn('rb', 'pb', 'wait');
    await flush();
    expect(a.agent.prompts).toEqual(['pa']);
    expect(b.agent.prompts).toEqual(['pb']);

    c.runner.runTurn('rc', 'pc', 'wait');
    await flush();
    expect(c.agent.prompts).toEqual([]);
    expect(slots.waitingCount).toBe(1);

    a.agent.finishRun();
    await flush();
    expect(c.agent.prompts).toEqual(['pc']);

    b.agent.finishRun();
    c.agent.finishRun();
    await flush();
  });

  it('keeps turns of the same session serial even with free slots', async () => {
    const events: WorkerStreamEvent[] = [];
    const slots = new SlotSemaphore(2);
    const a = makeRunner(slots, 'sess-a', events);

    a.runner.runTurn('r1', 'p1', 'wait');
    a.runner.runTurn('r2', 'p2', 'wait');
    await flush();
    expect(a.agent.prompts).toEqual(['p1']);
    expect(slots.activeCount).toBe(1);

    a.agent.finishRun();
    await flush();
    expect(a.agent.prompts).toEqual(['p1', 'p2']);
  });

  it('fails a turn aborted while waiting for a slot without starting it', async () => {
    const events: WorkerStreamEvent[] = [];
    const slots = new SlotSemaphore(1);
    const a = makeRunner(slots, 'sess-a', events);
    const b = makeRunner(slots, 'sess-b', events);

    a.runner.runTurn('ra', 'pa', 'wait');
    await flush();
    b.runner.runTurn('rb', 'pb', 'wait');
    await flush();

    expect(b.runner.abort('rb')).toBe(true);

    a.agent.finishRun();
    await flush();

    expect(b.agent.prompts).toEqual([]);
    expect(events.some((e) => e.type === 'run_started' && e.runId === 'rb')).toBe(false);
    expect(events).toContainEqual({
      type: 'run_failed',
      runId: 'rb',
      error: 'turn aborted',
      code: 'aborted',
    });
    // Slot was released after the skipped turn.
    expect(slots.activeCount).toBe(0);
  });
});
