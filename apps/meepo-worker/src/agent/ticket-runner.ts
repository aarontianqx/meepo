import { Agent } from '@earendil-works/pi-agent-core';
import { createCodingTools } from '@earendil-works/pi-coding-agent';
import type {
  TaskAbortPayload,
  TicketDispatchEnvelope,
  WorkerStreamEvent,
  WorkspaceSpec,
} from '@meepo/protocol';

import { createModel, createStreamFn } from './model-factory.js';
import { StreamForwarder } from './session-runner.js';

export interface TicketRunnerDeps {
  workerId: string;
  emit: (event: WorkerStreamEvent) => void;
  ensureWorktree: (id: string, spec: WorkspaceSpec) => Promise<string>;
}

const TICKET_SYSTEM_PROMPT = [
  'You are Meepo, an autonomous coding agent executing a ticket in a fresh git worktree.',
  'Use the read/bash/edit/write tools to accomplish the objective, then commit your work.',
  'When finished, summarize what you changed and why.',
].join('\n');

function buildTicketPrompt(envelope: TicketDispatchEnvelope): string {
  const parts = [`# Objective\n${envelope.objective}`];
  if (envelope.contextSummary) parts.push(`# Context\n${envelope.contextSummary}`);
  return parts.join('\n\n');
}

/**
 * Executes ticket dispatches: each ticket gets a brand-new agent in its own
 * worktree and runs exactly one turn. No snapshot, no queue, no cron tools —
 * tickets are stateless across lifetimes by design.
 */
export class TicketRunner {
  private readonly active = new Map<string, Agent>();

  constructor(private readonly deps: TicketRunnerDeps) {}

  async handleDispatch(envelope: TicketDispatchEnvelope): Promise<void> {
    const forwarder = new StreamForwarder(this.deps.emit);
    forwarder.beginTask(envelope.taskId, {
      workerId: this.deps.workerId,
      ticketId: envelope.ticketId,
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    try {
      const worktreePath = await this.deps.ensureWorktree(envelope.ticketId, envelope.workspace);
      const agent = new Agent({
        initialState: {
          systemPrompt: TICKET_SYSTEM_PROMPT,
          model: createModel(envelope.model),
          tools: createCodingTools(worktreePath),
        },
        streamFn: createStreamFn(envelope.model),
        sessionId: envelope.ticketId,
      });
      this.active.set(envelope.taskId, agent);
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
        forwarder.failTask(`ticket timed out after ${envelope.timeoutSeconds}s`, 'timeout');
      } else {
        forwarder.completeTask();
      }
    } catch (err) {
      forwarder.failTask((err as Error).message, 'internal');
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.active.delete(envelope.taskId);
    }
  }

  handleAbort(payload: TaskAbortPayload): void {
    this.active.get(payload.taskId)?.abort();
  }
}
