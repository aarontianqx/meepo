import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentMessage, AgentOptions } from '@earendil-works/pi-agent-core';
import type { ModelConfig, TicketDispatchEnvelope, WorkerStreamEvent } from '@meepo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunnerAgent } from '../session-runner.js';
import {
  TicketRunner,
  buildTicketPrompt,
  buildTicketSystemPrompt,
  type TicketRunnerDeps,
} from '../ticket-runner.js';

const model: ModelConfig = {
  provider: 'internal-gw',
  baseUrl: 'https://gw.internal/v1',
  apiKey: 'sk-test',
  model: 'qwen3-coder',
};

class StubAgent implements RunnerAgent {
  readonly state: { messages: AgentMessage[] } = { messages: [] };
  readonly prompts: string[] = [];
  subscribe(_listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }
  prompt(input: string): Promise<void> {
    this.prompts.push(input);
    return Promise.resolve();
  }
  steer(_message: AgentMessage): void {}
  abort(): void {}
}

function envelope(partial: Partial<TicketDispatchEnvelope> = {}): TicketDispatchEnvelope {
  return {
    taskId: 'task-1',
    ticketId: 'ticket-1',
    spaceId: 'space-1',
    objective: 'Fix the flaky login test',
    source: { kind: 'system' },
    model,
    ...partial,
  };
}

describe('buildTicketSystemPrompt', () => {
  it('contains the working directory, worktree rule, and contribution', () => {
    const prompt = buildTicketSystemPrompt('/tmp/ticket-1', 'Space memory: prefers pnpm.');
    expect(prompt).toContain('/tmp/ticket-1');
    expect(prompt).toContain('git worktree');
    expect(prompt).toContain('Space memory: prefers pnpm.');
  });

  it('omits the contribution when absent', () => {
    expect(buildTicketSystemPrompt('/tmp/ticket-1')).not.toContain('Space memory');
  });
});

describe('buildTicketPrompt', () => {
  it('combines objective and contextSummary', () => {
    const prompt = buildTicketPrompt(envelope({ contextSummary: 'Fails on CI only' }));
    expect(prompt).toBe('# Objective\nFix the flaky login test\n\n# Context\nFails on CI only');
  });

  it('omits the context section when absent', () => {
    expect(buildTicketPrompt(envelope())).toBe('# Objective\nFix the flaky login test');
  });
});

describe('TicketRunner', () => {
  let ticketsDir: string;

  beforeAll(async () => {
    ticketsDir = await mkdtemp(join(tmpdir(), 'meepo-tickets-test-'));
  });

  afterAll(async () => {
    await rm(ticketsDir, { recursive: true, force: true });
  });

  function setup(deps: Partial<TicketRunnerDeps> = {}) {
    const captured: AgentOptions[] = [];
    const agents: StubAgent[] = [];
    const events: WorkerStreamEvent[] = [];
    const runner = new TicketRunner({
      workerId: 'w1',
      emit: (event) => events.push(event),
      ticketsDir,
      createAgent: (options) => {
        captured.push(options);
        const agent = new StubAgent();
        agents.push(agent);
        return agent;
      },
      ...deps,
    });
    return { runner, captured, agents, events };
  }

  it('runs the ticket in a neutral per-ticket directory with coding tools only', async () => {
    const { runner, captured, agents, events } = setup();

    await runner.handleDispatch(envelope({ contextSummary: 'Fails on CI only' }));

    const workDir = join(ticketsDir, 'ticket-1');
    expect(existsSync(workDir)).toBe(true);
    expect(captured).toHaveLength(1);
    const initial = captured[0].initialState;
    expect(initial?.systemPrompt).toContain(workDir);
    expect(initial?.systemPrompt).toContain('git worktree');
    const toolNames = (initial?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
    expect(toolNames).not.toContain('CronCreate');

    expect(agents[0].prompts).toEqual([
      '# Objective\nFix the flaky login test\n\n# Context\nFails on CI only',
    ]);
    expect(events).toContainEqual({
      type: 'task_started',
      taskId: 'task-1',
      workerId: 'w1',
      sessionId: undefined,
      ticketId: 'ticket-1',
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'task_completed', taskId: 'task-1' })
    );
  });

  it('appends the server systemPromptContribution verbatim', async () => {
    const { runner, captured } = setup();

    await runner.handleDispatch(
      envelope({ systemPromptContribution: 'Space memory: prefers pnpm.' })
    );

    expect(captured[0].initialState?.systemPrompt).toContain('Space memory: prefers pnpm.');
  });

  it('aborts the in-flight ticket by taskId', async () => {
    let aborted = 0;
    let resolvePrompt!: () => void;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const { runner } = setup({
      createAgent: () => {
        const agent = new StubAgent();
        agent.prompt = () => {
          markPromptStarted();
          return new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });
        };
        agent.abort = () => {
          aborted += 1;
          resolvePrompt();
        };
        return agent;
      },
    });

    const dispatch = runner.handleDispatch(envelope());
    await promptStarted;
    runner.handleAbort({ taskId: 'task-1' });

    expect(aborted).toBe(1);
    await dispatch;
  });
});
