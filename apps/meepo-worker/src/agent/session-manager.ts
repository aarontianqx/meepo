import { Agent, type AgentMessage, type AgentOptions } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import {
  WORKER_CHANNEL_METHODS,
  type ModelConfig,
  type SessionDispatchEnvelope,
  type SessionSnapshot,
  type TaskAbortPayload,
  type TaskSteerPayload,
  type TranscriptMessage,
  type WorkerStreamEvent,
  type WorkspaceSpec,
} from '@meepo/protocol';

import { createModel, createStreamFn } from './model-factory.js';
import { createCompactor } from './compaction.js';
import { SessionRunner, type RunnerAgent } from './session-runner.js';
import { buildCronTools } from './tools.js';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

export interface SessionManagerDeps {
  workerId: string;
  rpc: RpcFn;
  emit: (event: WorkerStreamEvent) => void;
  ensureWorktree: (id: string, spec: WorkspaceSpec) => Promise<string>;
  sessionTtlMs: number;
  now?: () => number;
  /** Factory seam for tests; defaults to the real pi Agent. */
  createAgent?: (options: AgentOptions) => RunnerAgent;
}

const MAIN_SESSION_SYSTEM_PROMPT = [
  'You are Meepo, an assistant embedded in a team chat. Answer concisely and helpfully.',
  'You have no workspace in this session: no file or shell tools are available.',
  'You can schedule future wakeups of this conversation with the cron tools:',
  'CronCreate (5-field cron expression + prompt + recurring flag), CronList, CronDelete.',
  'Use CronCreate with recurring=false for one-shot reminders.',
].join('\n');

const TASK_SESSION_SYSTEM_PROMPT = [
  'You are Meepo, a coding agent working in a dedicated git worktree.',
  'Use the read/bash/edit/write tools to inspect and modify the codebase to accomplish the task.',
  'You can schedule future wakeups of this session with the cron tools:',
  'CronCreate (5-field cron expression + prompt + recurring flag), CronList, CronDelete.',
  'Use CronCreate with recurring=false for one-shot reminders.',
].join('\n');

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Map a simplified server transcript entry back to a pi AgentMessage for cold-start rehydration. */
export function transcriptToAgentMessage(
  message: TranscriptMessage,
  index: number,
  model: ModelConfig
): AgentMessage {
  switch (message.role) {
    case 'user':
      // Multi-party windows: attribute each utterance to its speaker.
      return {
        role: 'user',
        content: message.author ? `[${message.author}] ${message.content}` : message.content,
        timestamp: message.timestamp,
      };
    case 'assistant': {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        api: 'openai-completions',
        provider: model.provider,
        model: model.model,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp: message.timestamp,
      };
      return assistant;
    }
    case 'tool':
      return {
        role: 'toolResult',
        toolCallId: `restored-${index}`,
        toolName: 'unknown',
        content: [{ type: 'text', text: message.content }],
        isError: false,
        timestamp: message.timestamp,
      };
  }
}

/**
 * Owns the worker's live session runners. Runners are created lazily on the
 * first dispatch for a session (cold-starting from the server-held snapshot),
 * kept while busy, and evicted once idle beyond the TTL — transcripts are the
 * server's truth, never persisted here.
 */
export class SessionManager {
  private readonly runners = new Map<string, SessionRunner>();
  private readonly pendingCreates = new Map<string, Promise<SessionRunner>>();
  private readonly taskToSession = new Map<string, string>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly deps: SessionManagerDeps) {}

  async handleDispatch(envelope: SessionDispatchEnvelope): Promise<void> {
    const runner = await this.getOrCreateRunner(envelope);
    this.taskToSession.set(envelope.taskId, envelope.sessionId);
    runner.runTurn(envelope.taskId, envelope.prompt, envelope.delivery, envelope.timeoutSeconds);
  }

  handleSteer(payload: TaskSteerPayload): void {
    const runner = this.runnerForTask(payload.taskId);
    runner?.steer(payload.message);
  }

  handleAbort(payload: TaskAbortPayload): void {
    const runner = this.runnerForTask(payload.taskId);
    if (runner?.abort(payload.taskId, payload.reason)) {
      this.taskToSession.delete(payload.taskId);
    }
  }

  /** Drop runners idle beyond the TTL. Safe to call periodically and in tests. */
  sweep(): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const [sessionId, runner] of this.runners) {
      if (!runner.busy && now - runner.idleSince >= this.deps.sessionTtlMs) {
        this.runners.delete(sessionId);
      }
    }
  }

  startSweep(intervalMs = 60_000): void {
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  runnerForSession(sessionId: string): SessionRunner | undefined {
    return this.runners.get(sessionId);
  }

  private runnerForTask(taskId: string): SessionRunner | undefined {
    const sessionId = this.taskToSession.get(taskId);
    return sessionId ? this.runners.get(sessionId) : undefined;
  }

  private getOrCreateRunner(envelope: SessionDispatchEnvelope): Promise<SessionRunner> {
    const existing = this.runners.get(envelope.sessionId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pendingCreates.get(envelope.sessionId);
    if (inflight) return inflight;
    const created = this.createRunner(envelope).finally(() => {
      this.pendingCreates.delete(envelope.sessionId);
    });
    this.pendingCreates.set(envelope.sessionId, created);
    return created;
  }

  private async createRunner(envelope: SessionDispatchEnvelope): Promise<SessionRunner> {
    const messages = await this.fetchSnapshot(envelope);
    const tools = [
      ...(await this.buildTools(envelope)),
      ...buildCronTools(this.deps.rpc, envelope.sessionId),
    ];
    const createAgent = this.deps.createAgent ?? ((options: AgentOptions) => new Agent(options));
    const agent = createAgent({
      initialState: {
        systemPrompt:
          envelope.sessionKind === 'main' ? MAIN_SESSION_SYSTEM_PROMPT : TASK_SESSION_SYSTEM_PROMPT,
        model: createModel(envelope.model),
        tools,
        messages,
      },
      streamFn: createStreamFn(envelope.model),
      sessionId: envelope.sessionId,
    });
    const runner = new SessionRunner({
      agent,
      sessionId: envelope.sessionId,
      workerId: this.deps.workerId,
      emit: this.deps.emit,
      now: this.deps.now,
      compactor: createCompactor(envelope.model),
    });
    this.runners.set(envelope.sessionId, runner);
    return runner;
  }

  private async fetchSnapshot(envelope: SessionDispatchEnvelope): Promise<AgentMessage[]> {
    const snapshot = (await this.deps.rpc(WORKER_CHANNEL_METHODS.sessionSnapshot, {
      sessionId: envelope.sessionId,
    })) as SessionSnapshot;
    return snapshot.messages.map((message, index) =>
      transcriptToAgentMessage(message, index, envelope.model)
    );
  }

  private async buildTools(envelope: SessionDispatchEnvelope) {
    if (envelope.sessionKind === 'main' || !envelope.workspace) return [];
    const worktreePath = await this.deps.ensureWorktree(envelope.sessionId, envelope.workspace);
    return createCodingTools(worktreePath);
  }
}
