import { loadDurableHistory } from './durable-history.js';
import { boundedTools } from './tool-output.js';
import { reclaimDirectories, touchDirectory } from './retention.js';
import { loadImages } from './media.js';
import type { AnyAgentTool } from './tools.js';
import { buildBasePrompt, renderPrompt, type PreparedPrompt } from './prompt.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Agent, type AgentMessage, type AgentOptions } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import {
  WORKER_CHANNEL_METHODS,
  formatUserMessage,
  type MediaReadResult,
  type ImageReference,
  type ModelConfig,
  type ContextAppendPayload,
  type RunAbortPayload,
  type RunSteerPayload,
  type SessionSnapshot,
  type TranscriptMessage,
  type TurnDispatchEnvelope,
  type WorkerStreamEvent,
} from '@meepo/protocol';

import { restoreEvents } from './history.js';
import { createModel, createStreamFn } from './model-factory.js';
import { createCompactor } from './compaction.js';
import { SessionRunner, type RunnerAgent } from './session-runner.js';
import type { SlotSemaphore } from './slot-semaphore.js';
import { buildCronTools, buildTicketTools, buildMemoryTools } from './tools.js';

type RpcFn = (method: string, params: unknown) => Promise<unknown>;

export interface SessionManagerDeps {
  workerId: string;
  extraTools?: () => AnyAgentTool[];
  acquireTools?: () => { tools: AnyAgentTool[]; release: () => void };
  beforeExecution?: (runId?: string) => Promise<void>;
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
  return buildBasePrompt(workDir, contribution);
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
  private shuttingDown = false;
  private readonly dispatchChains = new Map<string, Promise<void>>();
  private readonly toolReleases = new Map<string, () => void>();
  private readonly generations = new Map<string, number>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly models = new Map<string, ModelConfig>();
  private readonly runners = new Map<string, SessionRunner>();
  private readonly pendingCreates = new Map<string, Promise<SessionRunner>>();
  private readonly cancelledRuns = new Set<string>();
  private readonly runToSession = new Map<string, string>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly deps: SessionManagerDeps) {}

  handleDispatch(envelope: TurnDispatchEnvelope): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Worker shutting down'));
    this.runToSession.set(envelope.runId, envelope.sessionId);
    const generation = this.generations.get(envelope.sessionId) ?? 0;
    const previous = this.dispatchChains.get(envelope.sessionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => {
        if ((this.generations.get(envelope.sessionId) ?? 0) !== generation)
          throw new Error('Session closed before dispatch');
        return this.prepareDispatch(envelope);
      })
      .catch((error) => {
        this.runToSession.delete(envelope.runId);
        throw error;
      })
      .finally(() => this.cancelledRuns.delete(envelope.runId));
    this.dispatchChains.set(envelope.sessionId, task);
    void task
      .finally(() => {
        if (this.dispatchChains.get(envelope.sessionId) === task)
          this.dispatchChains.delete(envelope.sessionId);
      })
      .catch(() => undefined);
    return task;
  }
  private async prepareDispatch(envelope: TurnDispatchEnvelope): Promise<void> {
    await this.closing.get(envelope.sessionId);
    const generation = this.generations.get(envelope.sessionId) ?? 0;
    if (this.cancelledRuns.has(envelope.runId)) throw new Error('Run cancelled during startup');
    const runner = await this.getOrCreateRunner(envelope);
    if ((this.generations.get(envelope.sessionId) ?? 0) !== generation)
      throw new Error('Session closed during startup');
    this.runToSession.set(envelope.runId, envelope.sessionId);
    const media = await loadImages(
      envelope.images ?? [],
      await this.ensureSessionDir(envelope.sessionId),
      this.mediaSource(envelope),
      createModel(envelope.model).input.includes('image'),
      join(this.deps.sessionsDir, '.media')
    );
    if ((this.generations.get(envelope.sessionId) ?? 0) !== generation)
      throw new Error('Session closed during media loading');
    if (this.cancelledRuns.has(envelope.runId)) throw new Error('Run cancelled during startup');
    runner.runTurn(
      envelope.runId,
      `${envelope.currentTime ? `<current-time>${new Date(envelope.currentTime).toISOString()}</current-time>\n` : ''}${envelope.prompt}\n${media.notes.join('\n')}`,
      envelope.delivery,
      envelope.timeoutSeconds,
      media.images
    );
  }

  handleContextAppend(payload: ContextAppendPayload): void {
    const runner = this.runners.get(payload.sessionId);
    const model = this.models.get(payload.sessionId);
    if (runner && model) runner.appendHistory(restoreEvents(payload.events, model));
  }

  closeSession(sessionId: string): Promise<void> {
    const pending = this.closing.get(sessionId);
    if (pending) return pending;
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    const task = this.closeResources(sessionId, true, this.dispatchChains.get(sessionId)).finally(
      () => this.closing.delete(sessionId)
    );
    this.closing.set(sessionId, task);
    return task;
  }
  private async closeResources(
    sessionId: string,
    removeDirectory = true,
    pendingDispatch?: Promise<void>
  ): Promise<void> {
    await pendingDispatch?.catch(() => undefined);
    await this.pendingCreates.get(sessionId)?.catch(() => undefined);
    const runner = this.runners.get(sessionId);
    if (runner) {
      for (const [id, session] of this.runToSession)
        if (session === sessionId) runner.abort(id, 'session closed');
      // Keep the old runner and tool lease reachable until execution actually stops.
      // Replacement dispatches await closing; shutdown has a process-level deadline.
      while (runner.busy) await new Promise((resolve) => setTimeout(resolve, 25));
      this.runners.delete(sessionId);
    }
    this.toolReleases.get(sessionId)?.();
    this.toolReleases.delete(sessionId);
    this.models.delete(sessionId);
    if (removeDirectory && /^[a-zA-Z0-9_-]+$/.test(sessionId))
      await rm(join(this.deps.sessionsDir, sessionId), { recursive: true, force: true });
  }

  handleSteer(payload: RunSteerPayload): void {
    const runner = this.runnerForRun(payload.runId);
    runner?.steer(payload.message);
  }

  handleAbort(payload: RunAbortPayload): void {
    const runner = this.runnerForRun(payload.runId);
    if (runner?.abort(payload.runId, payload.reason)) {
      this.runToSession.delete(payload.runId);
    } else if (this.runToSession.has(payload.runId)) this.cancelledRuns.add(payload.runId);
  }

  /** Drop runners idle beyond the TTL. Safe to call periodically and in tests. */
  sweep(): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const [sessionId, runner] of this.runners) {
      if (!runner.busy && now - runner.idleSince >= this.deps.sessionTtlMs) {
        this.runners.delete(sessionId);
        this.toolReleases.get(sessionId)?.();
        this.toolReleases.delete(sessionId);
        this.models.delete(sessionId);
      }
    }
  }

  startSweep(intervalMs = 60_000): void {
    this.sweepTimer = setInterval(() => {
      this.sweep();
      void reclaimDirectories(
        this.deps.sessionsDir,
        new Set(['.media', ...this.runners.keys(), ...this.pendingCreates.keys()])
      ).catch((error) => console.error('Session cleanup failed', error));
    }, intervalMs);
    this.sweepTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopSweep();
    await Promise.allSettled(
      [...new Set(['.media', ...this.runners.keys(), ...this.pendingCreates.keys()])].map((id) => {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        return this.closeResources(id, false, this.dispatchChains.get(id));
      })
    );
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
    const created = this.createRunner(envelope)
      .catch((error) => {
        this.toolReleases.get(envelope.sessionId)?.();
        this.toolReleases.delete(envelope.sessionId);
        throw error;
      })
      .finally(() => {
        this.pendingCreates.delete(envelope.sessionId);
      });
    this.pendingCreates.set(envelope.sessionId, created);
    return created;
  }

  private async createRunner(envelope: TurnDispatchEnvelope): Promise<SessionRunner> {
    const messages = await this.fetchSnapshot(envelope);
    const workDir = await this.ensureSessionDir(envelope.sessionId);
    const lease = this.deps.acquireTools?.();
    if (lease) this.toolReleases.set(envelope.sessionId, lease.release);
    const executionRpc: RpcFn = (method, params) =>
      this.deps.rpc(method, {
        ...(params as Record<string, unknown>),
        runId: this.runners.get(envelope.sessionId)?.currentRunId,
      });
    const tools = boundedTools(
      [
        ...createCodingTools(workDir),
        ...(lease?.tools ?? this.deps.extraTools?.() ?? []),
        ...buildCronTools(executionRpc, envelope.sessionId),
        ...buildTicketTools(executionRpc, envelope.sessionId),
        ...buildMemoryTools(executionRpc, { sessionId: envelope.sessionId }),
      ],
      workDir
    );
    const prepared = this.deps.createAgent
      ? undefined
      : ((await this.deps.rpc(WORKER_CHANNEL_METHODS.promptPrepare, {
          sessionId: envelope.sessionId,
        })) as PreparedPrompt);
    const systemPrompt = prepared
      ? await renderPrompt(workDir, prepared, tools)
      : buildSessionSystemPrompt(workDir, envelope.systemPromptContribution);
    if (prepared)
      await this.deps.rpc(WORKER_CHANNEL_METHODS.promptRecord, {
        sessionId: envelope.sessionId,
        snapshot: { ...prepared, systemPrompt, tools: tools.map((t) => t.name) },
      });
    const createAgent = this.deps.createAgent ?? ((options: AgentOptions) => new Agent(options));
    this.models.set(envelope.sessionId, envelope.model);
    const agent = createAgent({
      prepareRequest: async () => {
        await this.deps.beforeExecution?.(this.runners.get(envelope.sessionId)?.currentRunId);
      },
      initialState: {
        systemPrompt,
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
      emit: (event) => {
        this.deps.emit(event);
        if (['run_completed', 'run_failed', 'run_merged', 'run_dropped'].includes(event.type))
          this.runToSession.delete(event.runId);
      },
      now: this.deps.now,
      compactor: createCompactor(envelope.model),
      slots: this.deps.slots,
      checkpoint: this.deps.beforeExecution,
    });
    this.runners.set(envelope.sessionId, runner);
    return runner;
  }

  private mediaSource(envelope: TurnDispatchEnvelope) {
    return {
      namespace: envelope.mediaNamespace ?? envelope.spaceId,
      download: async (ref: ImageReference) => {
        const result = (await this.deps.rpc(WORKER_CHANNEL_METHODS.mediaRead, {
          sessionId: envelope.sessionId,
          messageId: ref.messageId,
          fileKey: ref.fileKey,
        })) as MediaReadResult;
        if (result.sizeBytes > 10 * 1024 * 1024 || result.data.length > 14 * 1024 * 1024)
          throw new Error('image exceeds 10 MB');
        return Buffer.from(result.data, 'base64');
      },
    };
  }
  private async ensureSessionDir(sessionId: string): Promise<string> {
    if (this.deps.ensureSessionDir) return this.deps.ensureSessionDir(sessionId);
    const dir = join(this.deps.sessionsDir, sessionId);
    await mkdir(dir, { recursive: true });
    await touchDirectory(dir);
    return dir;
  }

  private async fetchSnapshot(envelope: TurnDispatchEnvelope): Promise<AgentMessage[]> {
    const compactor = createCompactor(envelope.model);
    const snapshot = await loadDurableHistory({
      fetch: async (afterSeq) =>
        (await this.deps.rpc(WORKER_CHANNEL_METHODS.sessionSnapshot, {
          sessionId: envelope.sessionId,
          beforeTimestamp: envelope.snapshotBefore,
          beforeSeq: envelope.snapshotBeforeSeq,
          useCompaction: true,
          afterSeq,
        })) as SessionSnapshot,
      summarize: compactor.summarize,
      checkpoint: async () => {
        if (this.cancelledRuns.has(envelope.runId))
          throw new Error('Run cancelled during history recovery');
        await this.deps.beforeExecution?.(envelope.runId);
      },
      record: async (cache, degraded) => {
        await this.deps.rpc(WORKER_CHANNEL_METHODS.compactionRecord, {
          sessionId: envelope.sessionId,
          runId: envelope.runId,
          ...cache,
          degraded,
        });
      },
    });
    if (snapshot.events) {
      const restored = restoreEvents(snapshot.events, envelope.model);
      const users = restored.filter((m) => m.role === 'user');
      let index = 0;
      for (const event of snapshot.events) {
        const payload = event.payload as TranscriptMessage;
        if (
          event.type !== 'system_note' &&
          !(event.type === 'user_message' || (event.type === 'message' && payload.role === 'user'))
        )
          continue;
        const message = users[index++];
        if (!message || message.role !== 'user' || !payload.images?.length) continue;
        const media = await loadImages(
          payload.images,
          await this.ensureSessionDir(envelope.sessionId),
          this.mediaSource(envelope),
          createModel(envelope.model).input.includes('image'),
          join(this.deps.sessionsDir, '.media')
        );
        message.content = [
          {
            type: 'text',
            text: `${typeof message.content === 'string' ? message.content : payload.content}\n${media.notes.join('\n')}`,
          },
          ...media.images,
        ];
      }
      return restored;
    }
    return snapshot.messages.map((message, index) =>
      transcriptToAgentMessage(message, index, envelope.model)
    );
  }
}
