import { randomUUID } from 'node:crypto';

import type { Run, SessionKind, Space, WorkerNode } from '@meepo/core';
import {
  WORKER_CHANNEL_EVENTS,
  type DeliveryMode,
  type DispatchSource,
  type ModelConfig,
  type TicketDispatchEnvelope,
  type TurnDispatchEnvelope,
} from '@meepo/protocol';

import { conflict, notFound, validation } from '../errors.js';
import type { RunRepository } from '../runs/run-repository.js';
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
  author?: string;
}

export interface DispatchOutcome {
  dispatched: boolean;
  queued: boolean;
  workerId?: string;
}

/**
 * Routes work to workers; every dispatch materializes a Run. Sessions are
 * pinned: main sessions to the space's boundWorkerId, thread sessions to a
 * randomly chosen eligible worker; a bound worker being offline queues the
 * turn server-side. Tickets are claimed by any eligible, least-loaded worker,
 * each (re)dispatch a new Run with an incremented attempt.
 */
export class DispatchService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository,
    private readonly workers: WorkerRepository,
    private readonly tickets: TicketRepository,
    private readonly runs: RunRepository,
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

    const prompt = formatPromptWithSource(input.prompt, input.source, input.author);
    await this.transcripts.appendMessage(session.id, {
      role: 'user',
      author: input.author,
      content: prompt,
      timestamp: Date.now(),
    });

    const workerId = session.boundWorkerId ?? (await this.bindSessionWorker(session.id, space));
    const envelope = this.buildTurnEnvelope(session.id, session.kind, space, {
      ...input,
      prompt,
    });
    const worker = await this.workers.getById(workerId);
    const online = worker && worker.status !== 'offline' && this.sender.isConnected(workerId);

    await this.runs.save({
      id: envelope.runId,
      work: { kind: 'turn', sessionId: session.id },
      attempt: 1,
      workerId,
      status: online ? 'dispatched' : 'queued',
      createdAt: Date.now(),
    });

    if (online) {
      this.sender.sendToWorker(workerId, {
        kind: 'notification',
        event: WORKER_CHANNEL_EVENTS.turnDispatch,
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

    const run: Run = {
      id: randomUUID(),
      work: { kind: 'ticket', ticketId: ticket.id },
      attempt: (await this.runs.latestAttempt(ticket.id)) + 1,
      workerId: worker.id,
      status: 'dispatched',
      createdAt: Date.now(),
    };
    const envelope: TicketDispatchEnvelope = {
      runId: run.id,
      ticketId: ticket.id,
      spaceId: space.id,
      objective: ticket.objective,
      contextSummary: ticket.contextSummary,
      systemPromptContribution: composeSystemPromptContribution(space),
      model,
      source: { kind: 'system' },
    };
    await this.runs.save(run);
    this.sender.sendToWorker(worker.id, {
      kind: 'notification',
      event: WORKER_CHANNEL_EVENTS.ticketDispatch,
      payload: envelope,
    });

    ticket.status = 'claimed';
    ticket.assignedWorkerId = worker.id;
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket);
    return { dispatched: true, queued: false, workerId: worker.id };
  }

  /**
   * Aborts a running Run by forwarding run.abort to its worker.
   * Returns false when the run is unknown or already terminal.
   */
  async abortRun(runId: string): Promise<boolean> {
    const run = await this.runs.getById(runId);
    if (!run || run.status === 'completed' || run.status === 'failed') return false;
    if (!run.workerId) return false;
    this.sender.sendToWorker(run.workerId, {
      kind: 'notification',
      event: 'run.abort',
      payload: { runId },
    });
    return true;
  }

  /**
   * Retries dispatch for every pending ticket (e.g. after slots free up).
   * Tickets without an eligible worker stay pending for the next round.
   */
  async dispatchPendingTickets(): Promise<number> {
    const pending = await this.tickets.listPending();
    let dispatched = 0;
    for (const ticket of pending) {
      try {
        const outcome = await this.dispatchTicket(ticket.id);
        if (outcome.dispatched) dispatched += 1;
      } catch {
        // leave for the next round
      }
    }
    return dispatched;
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
      event: WORKER_CHANNEL_EVENTS.turnDispatch,
      payload: merged,
    });
    await this.queue.deleteBySession(sessionId);
    for (const item of queued) {
      const run = await this.runs.getById(item.envelope.runId);
      if (run && run.status === 'queued') {
        run.status = 'dispatched';
        run.workerId = workerId;
        await this.runs.save(run);
      }
    }
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
      // Binding is placement, not capacity: any online, enrolled, tag-matched
      // worker will do (least loaded preferred); the turn queues at the worker.
      workerId = await this.pickSessionWorker(space);
      if (!workerId) throw validation(`No online worker enrolled for space ${space.id}`);
    }
    session.boundWorkerId = workerId;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session);
    return workerId;
  }

  private async pickSessionWorker(space: Space): Promise<string | undefined> {
    const candidates = (await this.workers.listServingSpace(space.id)).filter(
      (worker) =>
        worker.status !== 'offline' &&
        space.requiredTags.every((tag) => worker.tags.includes(tag)) &&
        this.sender.isConnected(worker.id)
    );
    return candidates.sort((a, b) => a.activeSlots / a.maxSlots - b.activeSlots / b.maxSlots)[0]
      ?.id;
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

  private buildTurnEnvelope(
    sessionId: string,
    sessionKind: SessionKind,
    space: Space,
    input: DispatchSessionTurnInput
  ): TurnDispatchEnvelope {
    const model = space.model ?? this.defaultModel;
    if (!model) throw validation(`No model configured for space ${space.id} or server default`);
    return {
      runId: randomUUID(),
      sessionId,
      spaceId: space.id,
      sessionKind,
      prompt: input.prompt,
      source: input.source,
      delivery: input.delivery,
      systemPromptContribution: composeSystemPromptContribution(space),
      model,
    };
  }
}

function composeSystemPromptContribution(space: Space): string {
  const parts: string[] = [];
  parts.push(
    `You are chatting in space "${space.name}". Its default repository is ${space.repoUrl} (branch ${space.defaultBranch}) — just a hint; nothing is cloned for you. If the task involves code, clone or worktree the repo yourself; if it doesn't, ignore this.`
  );
  if (space.longTermMemory.trim()) {
    parts.push(`Space long-term memory:\n${space.longTermMemory.trim()}`);
  }
  return parts.join('\n\n');
}

function mergeQueued(queued: QueuedDispatch[]): TurnDispatchEnvelope {
  const latest = queued[queued.length - 1].envelope;
  if (queued.length === 1) return latest;
  const mergedPrompt = queued
    .map((item, index) => `[queued message ${index + 1}]\n${item.envelope.prompt}`)
    .join('\n\n');
  return { ...latest, prompt: mergedPrompt, delivery: 'wait' };
}

/** Wraps schedule fires in an origin envelope so the agent knows why it woke. */
function formatPromptWithSource(prompt: string, source: DispatchSource, author?: string): string {
  if (source.kind === 'schedule') {
    return (
      `<schedule-fire scheduleId="${source.scheduleId}" coalescedCount="${source.coalescedCount}" ` +
      `stale="${source.stale}">\n${prompt}\n</schedule-fire>`
    );
  }
  if (source.kind === 'user_message' && author) {
    return `[user_name: ${author}]\n${prompt}`;
  }
  return prompt;
}
