import { randomUUID } from 'node:crypto';

import type { Space, WorkerNode } from '@meepo/core';
import type {
  DeliveryMode,
  DispatchSource,
  ModelConfig,
  SessionDispatchEnvelope,
  TicketDispatchEnvelope,
} from '@meepo/protocol';

import { conflict, notFound, validation } from '../errors.js';
import type { SessionRepository } from '../sessions/session-repository.js';
import type { TranscriptService } from '../sessions/transcript-service.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { TicketRepository } from '../tickets/ticket-repository.js';
import type { WorkerRepository } from '../workers/worker-repository.js';
import type { DispatchQueueRepository, QueuedDispatch } from './dispatch-queue-repository.js';
import type { WorkerSender } from './worker-sender.js';

export interface DispatchSessionTurnInput {
  sessionId: string;
  prompt: string;
  source: DispatchSource;
  delivery: DeliveryMode;
}

export interface DispatchOutcome {
  dispatched: boolean;
  queued: boolean;
  workerId?: string;
}

/**
 * Routes work to workers. Sessions are pinned: main sessions to the space's
 * boundWorkerId, task sessions to a randomly chosen eligible worker; a bound
 * worker being offline queues the turn server-side. Tickets are claimed by
 * any eligible, least-loaded worker.
 */
export class DispatchService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository,
    private readonly workers: WorkerRepository,
    private readonly tickets: TicketRepository,
    private readonly queue: DispatchQueueRepository,
    private readonly sender: WorkerSender,
    private readonly transcripts: TranscriptService,
    private readonly defaultModel?: ModelConfig
  ) {}

  async dispatchSessionTurn(input: DispatchSessionTurnInput): Promise<DispatchOutcome> {
    const session = await this.sessions.getById(input.sessionId);
    if (!session) throw notFound(`Session not found: ${input.sessionId}`);
    const space = await this.spaces.getById(session.spaceId);
    if (!space) throw notFound(`Space not found: ${session.spaceId}`);

    const prompt = formatPromptWithSource(input.prompt, input.source);
    await this.transcripts.appendMessage(session.id, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    const workerId = session.boundWorkerId ?? (await this.bindSessionWorker(session.id, space));
    const envelope = this.buildSessionEnvelope(session.id, session.kind, space, {
      ...input,
      prompt,
    });
    const worker = await this.workers.getById(workerId);

    if (worker && worker.status !== 'offline' && this.sender.isConnected(workerId)) {
      this.sender.sendToWorker(workerId, {
        kind: 'notification',
        event: 'session.dispatch',
        payload: envelope,
      });
      return { dispatched: true, queued: false, workerId };
    }

    await this.queue.enqueue({
      id: randomUUID(),
      sessionId: session.id,
      envelope,
      queuedAt: Date.now(),
    });
    return { dispatched: false, queued: true, workerId };
  }

  async dispatchTicket(ticketId: string): Promise<DispatchOutcome> {
    const ticket = await this.tickets.getById(ticketId);
    if (!ticket) throw notFound(`Ticket not found: ${ticketId}`);
    if (ticket.status !== 'pending') {
      throw conflict(`Ticket ${ticketId} is ${ticket.status}, only pending tickets can dispatch`);
    }
    const space = await this.spaces.getById(ticket.spaceId);
    if (!space) throw notFound(`Space not found: ${ticket.spaceId}`);
    const model = space.model ?? this.defaultModel;
    if (!model) throw validation(`No model configured for space ${space.id} or server default`);

    const eligible = await this.eligibleWorkers(space, ticket.requiredTags);
    const worker = eligible.sort(
      (a, b) => a.activeSlots / a.maxSlots - b.activeSlots / b.maxSlots
    )[0];
    if (!worker) return { dispatched: false, queued: false };

    const envelope: TicketDispatchEnvelope = {
      taskId: randomUUID(),
      ticketId: ticket.id,
      spaceId: space.id,
      objective: ticket.objective,
      contextSummary: ticket.contextSummary,
      workspace: { repoUrl: space.repoUrl, branch: space.defaultBranch },
      model,
      source: { kind: 'system' },
    };
    this.sender.sendToWorker(worker.id, {
      kind: 'notification',
      event: 'ticket.dispatch',
      payload: envelope,
    });

    ticket.status = 'claimed';
    ticket.assignedWorkerId = worker.id;
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket);
    return { dispatched: true, queued: false, workerId: worker.id };
  }

  /**
   * Delivers everything queued for a session, coalescing all queued turns
   * into a single dispatch with the merged prompt. Returns the merge count.
   */
  async flushSessionQueue(sessionId: string, workerId: string): Promise<number> {
    const queued = await this.queue.listBySession(sessionId);
    if (queued.length === 0) return 0;
    const merged = mergeQueued(queued);
    this.sender.sendToWorker(workerId, {
      kind: 'notification',
      event: 'session.dispatch',
      payload: merged,
    });
    await this.queue.deleteBySession(sessionId);
    return queued.length;
  }

  /** Delivers queues for every session pinned to a (re)connected worker. */
  async flushWorkerQueues(workerId: string): Promise<number> {
    const sessionIds = await this.queue.listSessionIds();
    let flushed = 0;
    for (const sessionId of sessionIds) {
      const session = await this.sessions.getById(sessionId);
      if (session?.boundWorkerId !== workerId) continue;
      flushed += await this.flushSessionQueue(sessionId, workerId);
    }
    return flushed;
  }

  private async bindSessionWorker(sessionId: string, space: Space): Promise<string> {
    const session = await this.sessions.getById(sessionId);
    if (!session) throw notFound(`Session not found: ${sessionId}`);
    let workerId: string | undefined;
    if (session.kind === 'main') {
      workerId = space.boundWorkerId;
      if (!workerId) throw validation(`Space ${space.id} has no bound worker`);
    } else {
      const eligible = await this.eligibleWorkers(space, space.requiredTags);
      workerId = eligible[Math.floor(Math.random() * eligible.length)]?.id;
      if (!workerId) throw validation(`No eligible worker for space ${space.id}`);
    }
    session.boundWorkerId = workerId;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session);
    return workerId;
  }

  private async eligibleWorkers(space: Space, requiredTags: string[]): Promise<WorkerNode[]> {
    return (await this.workers.listServingSpace(space.id)).filter(
      (worker) =>
        worker.status !== 'offline' &&
        worker.activeSlots < worker.maxSlots &&
        requiredTags.every((tag) => worker.tags.includes(tag)) &&
        this.sender.isConnected(worker.id)
    );
  }

  private buildSessionEnvelope(
    sessionId: string,
    sessionKind: 'main' | 'task',
    space: Space,
    input: DispatchSessionTurnInput
  ): SessionDispatchEnvelope {
    const model = space.model ?? this.defaultModel;
    if (!model) throw validation(`No model configured for space ${space.id} or server default`);
    return {
      taskId: randomUUID(),
      sessionId,
      spaceId: space.id,
      sessionKind,
      prompt: input.prompt,
      source: input.source,
      delivery: input.delivery,
      workspace:
        sessionKind === 'main' ? null : { repoUrl: space.repoUrl, branch: space.defaultBranch },
      model,
    };
  }
}

function mergeQueued(queued: QueuedDispatch[]): SessionDispatchEnvelope {
  const latest = queued[queued.length - 1].envelope;
  if (queued.length === 1) return latest;
  const mergedPrompt = queued
    .map((item, index) => `[queued message ${index + 1}]\n${item.envelope.prompt}`)
    .join('\n\n');
  return { ...latest, prompt: mergedPrompt, delivery: 'wait' };
}

/** Wraps scheduled triggers in an origin envelope so the agent knows why it woke. */
function formatPromptWithSource(prompt: string, source: DispatchSource): string {
  if (source.kind === 'cron') {
    return (
      `<cron-fire jobId="${source.jobId}" coalescedCount="${source.coalescedCount}" ` +
      `stale="${source.stale}">\n${prompt}\n</cron-fire>`
    );
  }
  if (source.kind === 'reminder') {
    return `<reminder-fire reminderId="${source.reminderId}">\n${prompt}\n</reminder-fire>`;
  }
  return prompt;
}
