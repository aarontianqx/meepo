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
  const parts = [
    `You are Meepo, a background task execution agent. Your current working directory is ${workDir}.`,
    [
      'Working rules:',
      '- When the task involves code, clone the repository yourself into your working directory.',
      '  Do not assume any repository already exists.',
      '- Before modifying any code, always create an isolated git worktree for your changes',
      '  to avoid conflicts with concurrent executions.',
      '- When finished, summarize what you changed and why.',
    ].join('\n'),
  ];
  if (contribution) parts.push(contribution);
  return parts.join('\n\n');
}

/** The ticket's single user prompt: the objective plus optional context. */
export function buildTicketPrompt(envelope: TicketDispatchEnvelope): string {
  const parts = [`# Objective\n${envelope.objective}`];
  if (envelope.contextSummary) parts.push(`# Context\n${envelope.contextSummary}`);
  return parts.join('\n\n');
}

interface ActiveRun {
  agent?: RunnerAgent;
  aborted: boolean;
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
    const entry: ActiveRun = { aborted: false };
    this.active.set(envelope.runId, entry);

    let timeoutTimer: NodeJS.Timeout | undefined;
    await this.deps.slots?.acquire();
    try {
      if (entry.aborted) {
        // Aborted while queued for a slot: never started.
        forwarder.failPendingRun(envelope.runId, 'aborted before execution', 'aborted');
        return;
      }
      forwarder.beginRun(envelope.runId, {
        workerId: this.deps.workerId,
        ticketId: envelope.ticketId,
      });
      const workDir = await this.ensureTicketDir(envelope.ticketId);
      const createAgent = this.deps.createAgent ?? ((options: AgentOptions) => new Agent(options));
      const agent = createAgent({
        initialState: {
          systemPrompt: buildTicketSystemPrompt(workDir, envelope.systemPromptContribution),
          model: createModel(envelope.model),
          tools: createCodingTools(workDir),
        },
        streamFn: createStreamFn(envelope.model),
        sessionId: envelope.ticketId,
      });
      entry.agent = agent;
      agent.subscribe((event) => forwarder.handleEvent(event));

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
      } else {
        forwarder.completeRun();
      }
    } catch (err) {
      forwarder.failRun((err as Error).message, 'internal');
    } finally {
      this.deps.slots?.release();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.active.delete(envelope.runId);
    }
  }

  handleAbort(payload: RunAbortPayload): void {
    const entry = this.active.get(payload.runId);
    if (!entry) return;
    entry.aborted = true;
    entry.agent?.abort();
  }

  private async ensureTicketDir(ticketId: string): Promise<string> {
    if (this.deps.ensureTicketDir) return this.deps.ensureTicketDir(ticketId);
    const dir = join(this.deps.ticketsDir, ticketId);
    await mkdir(dir, { recursive: true });
    return dir;
  }
}
