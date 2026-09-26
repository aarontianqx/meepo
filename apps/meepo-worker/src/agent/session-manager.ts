import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Agent, type AgentMessage, type AgentOptions } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import {
  WORKER_CHANNEL_METHODS,
  formatUserMessage,
  type ModelConfig,
  type RunAbortPayload,
  type RunSteerPayload,
  type SessionSnapshot,
  type TranscriptMessage,
  type TurnDispatchEnvelope,
  type WorkerStreamEvent,
} from '@meepo/protocol';

import { createModel, createStreamFn } from './model-factory.js';
import { createCompactor } from './compaction.js';
import { SessionRunner, type RunnerAgent } from './session-runner.js';
import type { SlotSemaphore } from './slot-semaphore.js';
import { buildCronTools, buildTicketTools } from './tools.js';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

export interface SessionManagerDeps {
  workerId: string;
  rpc: RpcFn;
  emit: (event: WorkerStreamEvent) => void;
  /** Root for neutral per-session working directories (`<sessionsDir>/<sessionId>`). */
  sessionsDir: string;
  sessionTtlMs: number;
  /** Worker-global run concurrency limit shared with the ticket runner. */
  slots?: SlotSemaphore;
  now?: () => number;
  /** Factory seam for tests; defaults to mkdir -p under sessionsDir. */
  ensureSessionDir?: (sessionId: string) => Promise<string>;
  /** Factory seam for tests; defaults to the real pi Agent. */
  createAgent?: (options: AgentOptions) => RunnerAgent;
}

/**
 * Assemble the session system prompt: base identity + working rules, the
 * server-injected space contribution verbatim, and the cron tools note.
 */
export function buildSessionSystemPrompt(workDir: string, contribution?: string): string {
  const parts = [
    `You are Meepo, a coding and collaboration agent. Your current working directory is ${workDir}.`,
    [
      'Working rules:',
      '- When a task involves code, clone the repository yourself into your working directory,',
      '  or into a path the user specifies. Do not assume any repository already exists.',
      '- Before modifying any code, always create an isolated git worktree for your changes',
      '  to avoid conflicts with concurrent sessions.',
    ].join('\n'),
  ];
  if (contribution) parts.push(contribution);
  parts.push(
    [
      'Scheduling tools:',
      '- CronCreate/CronList/CronDelete manage wakeups of THIS session (one-shot "at" or recurring',
      '  "cron" timing), preserving this conversation\'s context.',
      '- TicketCreate spawns an independent background task with a self-contained objective',
      '  (optionally scheduled) that runs in a fresh context.',
    ].join('\n')
  );
  return parts.join('\n\n');
}

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
      // Multi-party windows: attribute each utterance to its speaker, structured
      // so the agent can tell senders apart.
      return {
        role: 'user',
        content: message.author
          ? formatUserMessage(message.content, {
              author: message.author,
              authorOpenId: message.authorOpenId,
              chatLabel: message.chatLabel,
              timestamp: message.timestamp,
            })
          : message.content,
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
  private readonly runToSession = new Map<string, string>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly deps: SessionManagerDeps) {}

  async handleDispatch(envelope: TurnDispatchEnvelope): Promise<void> {
    const runner = await this.getOrCreateRunner(envelope);
    this.runToSession.set(envelope.runId, envelope.sessionId);
    runner.runTurn(envelope.runId, envelope.prompt, envelope.delivery, envelope.timeoutSeconds);
  }

  handleSteer(payload: RunSteerPayload): void {
    const runner = this.runnerForRun(payload.runId);
    runner?.steer(payload.message);
  }

  handleAbort(payload: RunAbortPayload): void {
    const runner = this.runnerForRun(payload.runId);
    if (runner?.abort(payload.runId, payload.reason)) {
      this.runToSession.delete(payload.runId);
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

  private runnerForRun(runId: string): SessionRunner | undefined {
    const sessionId = this.runToSession.get(runId);
    return sessionId ? this.runners.get(sessionId) : undefined;
  }

  private getOrCreateRunner(envelope: TurnDispatchEnvelope): Promise<SessionRunner> {
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

  private async createRunner(envelope: TurnDispatchEnvelope): Promise<SessionRunner> {
    const messages = await this.fetchSnapshot(envelope);
    const workDir = await this.ensureSessionDir(envelope.sessionId);
    const tools = [
      ...createCodingTools(workDir),
      ...buildCronTools(this.deps.rpc, envelope.sessionId),
      ...buildTicketTools(this.deps.rpc, envelope.sessionId),
    ];
    const createAgent = this.deps.createAgent ?? ((options: AgentOptions) => new Agent(options));
    const agent = createAgent({
      initialState: {
        systemPrompt: buildSessionSystemPrompt(workDir, envelope.systemPromptContribution),
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
      slots: this.deps.slots,
    });
    this.runners.set(envelope.sessionId, runner);
    return runner;
  }

  private async ensureSessionDir(sessionId: string): Promise<string> {
    if (this.deps.ensureSessionDir) return this.deps.ensureSessionDir(sessionId);
    const dir = join(this.deps.sessionsDir, sessionId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async fetchSnapshot(envelope: TurnDispatchEnvelope): Promise<AgentMessage[]> {
    const snapshot = (await this.deps.rpc(WORKER_CHANNEL_METHODS.sessionSnapshot, {
      sessionId: envelope.sessionId,
      beforeTimestamp: envelope.snapshotBefore,
    })) as SessionSnapshot;
    return snapshot.messages.map((message, index) =>
      transcriptToAgentMessage(message, index, envelope.model)
    );
  }
}
