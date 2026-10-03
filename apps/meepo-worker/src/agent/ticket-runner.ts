import { boundedTools } from './tool-output.js';
import { reclaimDirectories, touchDirectory } from './retention.js';
import { withTicketContext } from './tool-context.js';
import type { AnyAgentTool } from './tools.js';
import { buildBasePrompt, renderPrompt, type PreparedPrompt } from './prompt.js';
import { WORKER_CHANNEL_METHODS } from '@meepo/protocol';
import { buildMemoryTools } from './tools.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Agent, type AgentOptions } from '@earendil-works/pi-agent-core';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import type { RunAbortPayload, TicketDispatchEnvelope, WorkerStreamEvent } from '@meepo/protocol';

import { createModel, createStreamFn } from './model-factory.js';
import { StreamForwarder, type RunnerAgent } from './session-runner.js';
import type { SlotSemaphore } from './slot-semaphore.js';

export interface TicketRunnerDeps {
  workerId: string;
  extraTools?: () => AnyAgentTool[];
  acquireTools?: () => { tools: AnyAgentTool[]; release: () => void };
  rpc?: (method: string, params: unknown) => Promise<unknown>;
  beforeExecution?: (runId?: string) => Promise<void>;
  emit: (event: WorkerStreamEvent) => void;
  /** Root for neutral per-ticket working directories (`<ticketsDir>/<ticketId>`). */
  ticketsDir: string;
  /** Worker-global run concurrency limit shared with the session manager. */
  slots?: SlotSemaphore;
  /** Factory seam for tests; defaults to mkdir -p under ticketsDir. */
  ensureTicketDir?: (ticketId: string) => Promise<string>;
  /** Factory seam for tests; defaults to the real pi Agent. */
  createAgent?: (options: AgentOptions) => RunnerAgent;
}

/**
 * Assemble the ticket system prompt: base identity + working rules, plus the
 * server-injected space contribution verbatim when present.
 */
export function buildTicketSystemPrompt(workDir: string, contribution?: string): string {
  return buildBasePrompt(workDir, contribution, false);
}

/** The ticket's single user prompt: the objective plus optional context. */
export function buildTicketPrompt(envelope: TicketDispatchEnvelope): string {
  const parts = [
    `Current time: ${new Date(envelope.currentTime ?? Date.now()).toISOString()}`,
    `# Objective\n${envelope.objective}`,
  ];
  parts.push(
    `Tool environment: MEEPO_IDEMPOTENCY_KEY=${envelope.ticketId}-${envelope.attempt ?? 1}. Pass this value as the idempotency key on external API calls.`
  );
  if (envelope.contextSummary) parts.push(`# Context\n${envelope.contextSummary}`);
  return parts.join('\n\n');
}

interface ActiveRun {
  ticketId: string;
  agent?: RunnerAgent;
  aborted: boolean;
  slotWait: AbortController;
}

/**
 * Executes ticket dispatches: each ticket gets a brand-new agent in a neutral
 * per-ticket directory and runs exactly one turn. No snapshot, no queue, no
 * cron tools — tickets are stateless across lifetimes by design. Execution is
 * bounded by the worker-global slot semaphore; tickets waiting for a slot can
 * still be aborted.
 */
export class TicketRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: TicketRunnerDeps) {}

  async handleDispatch(envelope: TicketDispatchEnvelope): Promise<void> {
    const forwarder = new StreamForwarder(this.deps.emit);
    const entry: ActiveRun = {
      aborted: false,
      ticketId: envelope.ticketId,
      slotWait: new AbortController(),
    };
    this.active.set(envelope.runId, entry);

    let releaseTools: (() => void) | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let acquired = false;
    try {
      if (this.deps.slots) {
        await this.deps.slots.acquire('ticket', entry.slotWait.signal);
        acquired = true;
      }
      if (entry.aborted) {
        // Aborted while queued for a slot: never started.
        forwarder.failPendingRun(envelope.runId, 'aborted before execution', 'aborted');
        return;
      }
      forwarder.beginRun(envelope.runId, {
        workerId: this.deps.workerId,
        ticketId: envelope.ticketId,
      });
      const workDir = await this.ensureTicketDir(envelope.ticketId, envelope.attempt ?? 1);
      const lease = this.deps.acquireTools?.();
      releaseTools = lease?.release;
      const tools = withTicketContext(
        boundedTools(
          [
            ...createCodingTools(workDir),
            ...(lease?.tools ?? this.deps.extraTools?.() ?? []),
            ...(this.deps.rpc
              ? buildMemoryTools(
                  (method, params) =>
                    this.deps.rpc!(method, {
                      ...(params as Record<string, unknown>),
                      runId: envelope.runId,
                    }),
                  { ticketId: envelope.ticketId }
                )
              : []),
          ],
          workDir
        ),
        `${envelope.ticketId}-${envelope.attempt ?? 1}`
      );
      const prepared =
        !this.deps.createAgent && this.deps.rpc
          ? ((await this.deps.rpc(WORKER_CHANNEL_METHODS.promptPrepare, {
              ticketId: envelope.ticketId,
            })) as PreparedPrompt)
          : undefined;
      const systemPrompt = prepared
        ? await renderPrompt(workDir, prepared, tools, false)
        : buildTicketSystemPrompt(workDir, envelope.systemPromptContribution);
      const createAgent = this.deps.createAgent ?? ((options: AgentOptions) => new Agent(options));
      const agent = createAgent({
        prepareRequest: async () => {
          await this.deps.beforeExecution?.(envelope.runId);
        },
        initialState: {
          systemPrompt,
          model: createModel(envelope.model),
          tools,
        },
        streamFn: createStreamFn(envelope.model),
        sessionId: envelope.ticketId,
      });
      entry.agent = agent;
      if (entry.aborted) throw new Error('Ticket cancelled during startup');
      agent.subscribe((event) => {
        forwarder.handleEvent(event);
        if (event.type !== 'message_update' && event.type !== 'tool_execution_update')
          return this.deps.beforeExecution?.(envelope.runId);
      });

      let timedOut = false;
      if (envelope.timeoutSeconds) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          agent.abort();
        }, envelope.timeoutSeconds * 1000);
        timeoutTimer.unref();
      }

      await agent.prompt(buildTicketPrompt(envelope));
      if (timedOut) {
        forwarder.failRun(`ticket timed out after ${envelope.timeoutSeconds}s`, 'timeout');
      } else if (entry.aborted) {
        forwarder.failRun('Ticket cancelled', 'interrupted');
      } else {
        forwarder.completeRun();
      }
    } catch (err) {
      if (!forwarder.currentRunId)
        forwarder.failPendingRun(
          envelope.runId,
          (err as Error).message,
          entry.aborted ? 'aborted' : 'internal'
        );
      else forwarder.failRun((err as Error).message, 'internal');
    } finally {
      releaseTools?.();
      if (acquired) this.deps.slots!.release();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.active.delete(envelope.runId);
      void reclaimDirectories(
        this.deps.ticketsDir,
        new Set([...this.active.values()].map((r) => r.ticketId))
      ).catch((error) => console.error('Ticket cleanup failed', error));
    }
  }

  async reclaim(): Promise<void> {
    await reclaimDirectories(
      this.deps.ticketsDir,
      new Set([...this.active.values()].map((r) => r.ticketId))
    );
  }
  async shutdown(): Promise<void> {
    for (const id of this.active.keys())
      this.handleAbort({ runId: id, reason: 'Worker shutting down' });
    for (let i = 0; this.active.size && i < 200; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }

  handleAbort(payload: RunAbortPayload): void {
    const entry = this.active.get(payload.runId);
    if (!entry) return;
    entry.aborted = true;
    entry.slotWait.abort();
    entry.agent?.abort();
  }

  private async ensureTicketDir(ticketId: string, attempt: number): Promise<string> {
    if (this.deps.ensureTicketDir) return this.deps.ensureTicketDir(ticketId);
    const dir = join(this.deps.ticketsDir, ticketId, `attempt-${attempt}`);
    await mkdir(dir, { recursive: true });
    await touchDirectory(join(this.deps.ticketsDir, ticketId));
    return dir;
  }
}
