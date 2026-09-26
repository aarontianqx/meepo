import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentMessage, AgentOptions } from '@earendil-works/pi-agent-core';
import {
  WORKER_CHANNEL_METHODS,
  type ModelConfig,
  type TurnDispatchEnvelope,
  type TranscriptMessage,
} from '@meepo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SessionManager,
  buildSessionSystemPrompt,
  transcriptToAgentMessage,
  type SessionManagerDeps,
} from '../session-manager.js';
import type { RunnerAgent } from '../session-runner.js';

const model: ModelConfig = {
  provider: 'internal-gw',
  baseUrl: 'https://gw.internal/v1',
  apiKey: 'sk-test',
  model: 'qwen3-coder',
};

function entry(
  partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, 'role'>
): TranscriptMessage {
  return { content: 'content', timestamp: 0, ...partial };
}

describe('transcriptToAgentMessage', () => {
  it('prefixes user messages with the author when present', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'user', content: 'hello', author: 'Alice' }),
      0,
      model
    );
    expect(message.role).toBe('user');
    if (message.role !== 'user') throw new Error('expected user message');
    const content = message.content as string;
    expect(content).toContain('sender="Alice"');
    expect(content).toContain('hello');
    expect(content).toContain('<message');
    expect(content).toContain('</message>');
  });

  it('leaves user messages without an author untouched', () => {
    const message = transcriptToAgentMessage(entry({ role: 'user', content: 'hello' }), 0, model);
    expect(message).toEqual({ role: 'user', content: 'hello', timestamp: 0 });
  });

  it('does not prefix assistant messages even when an author is present', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'assistant', content: 'reply', author: 'meepo-bot' }),
      1,
      model
    );
    expect(message.role).toBe('assistant');
    expect(message).toMatchObject({
      content: [{ type: 'text', text: 'reply' }],
      api: 'openai-completions',
      provider: model.provider,
      model: model.model,
      stopReason: 'stop',
    });
  });

  it('maps tool entries to toolResult messages without an author prefix', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'tool', content: 'ls output' }),
      2,
      model
    );
    expect(message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'restored-2',
      content: [{ type: 'text', text: 'ls output' }],
      isError: false,
    });
  });
});

class StubAgent implements RunnerAgent {
  readonly state: { messages: AgentMessage[] } = { messages: [] };
  subscribe(_listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }
  prompt(_input: string): Promise<void> {
    return new Promise(() => undefined);
  }
  steer(_message: AgentMessage): void {}
  abort(): void {}
}

function envelope(partial: Partial<TurnDispatchEnvelope> = {}): TurnDispatchEnvelope {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    spaceId: 'space-1',
    sessionKind: 'main',
    prompt: 'hi',
    source: { kind: 'system' },
    delivery: 'wait',
    model,
    ...partial,
  };
}

describe('buildSessionSystemPrompt', () => {
  it('contains the working directory, worktree rule, contribution, and cron note', () => {
    const prompt = buildSessionSystemPrompt('/tmp/sess-1', 'Space memory: prefers pnpm.');
    expect(prompt).toContain('/tmp/sess-1');
    expect(prompt).toContain('git worktree');
    expect(prompt).toContain('Space memory: prefers pnpm.');
    expect(prompt).toContain('CronCreate');
  });

  it('omits the contribution when absent', () => {
    const prompt = buildSessionSystemPrompt('/tmp/sess-1');
    expect(prompt).toContain('git worktree');
    expect(prompt).not.toContain('Space memory');
  });
});

describe('SessionManager runner creation', () => {
  let sessionsDir: string;

  beforeAll(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'meepo-sessions-test-'));
  });

  afterAll(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  function setup(deps: Partial<SessionManagerDeps> = {}) {
    const captured: AgentOptions[] = [];
    const manager = new SessionManager({
      workerId: 'w1',
      rpc: (method) => {
        if (method === WORKER_CHANNEL_METHODS.sessionSnapshot) {
          return Promise.resolve({ sessionId: 'sess-1', version: 1, messages: [] });
        }
        return Promise.resolve({});
      },
      emit: () => undefined,
      sessionsDir,
      sessionTtlMs: 60_000,
      createAgent: (options) => {
        captured.push(options);
        return new StubAgent();
      },
      ...deps,
    });
    return { manager, captured };
  }

  it('creates a neutral per-session directory and equips coding + cron + ticket tools', async () => {
    const { manager, captured } = setup();

    await manager.handleDispatch(envelope());

    const workDir = join(sessionsDir, 'sess-1');
    expect(existsSync(workDir)).toBe(true);
    expect(captured).toHaveLength(1);
    const initial = captured[0].initialState;
    expect(initial?.systemPrompt).toContain(workDir);
    expect(initial?.systemPrompt).toContain('git worktree');
    const toolNames = (initial?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
    expect(toolNames).toEqual(expect.arrayContaining(['CronCreate', 'CronList', 'CronDelete']));
    expect(toolNames).toContain('TicketCreate');
  });

  it('appends the server systemPromptContribution verbatim', async () => {
    const { manager, captured } = setup();

    await manager.handleDispatch(
      envelope({ systemPromptContribution: 'Space memory: prefers pnpm.' })
    );

    expect(captured[0].initialState?.systemPrompt).toContain('Space memory: prefers pnpm.');
  });

  it('treats thread sessions the same: neutral directory with coding tools', async () => {
    const { manager, captured } = setup();

    await manager.handleDispatch(envelope({ sessionId: 'sess-thread', sessionKind: 'thread' }));

    const workDir = join(sessionsDir, 'sess-thread');
    expect(existsSync(workDir)).toBe(true);
    const toolNames = (captured[0].initialState?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
  });

  it('reuses the runner (and directory) for subsequent dispatches', async () => {
    const { manager, captured } = setup();

    await manager.handleDispatch(envelope());
    await manager.handleDispatch(envelope({ runId: 'run-2', prompt: 'again' }));

    expect(captured).toHaveLength(1);
    expect(manager.runnerForSession('sess-1')).toBeDefined();
  });
});
