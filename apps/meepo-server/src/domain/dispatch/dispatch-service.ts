import type { ExecutionJournal } from '../runs/execution-journal.js';
import { randomInt, randomUUID } from 'node:crypto';

import {
  isTerminalRun,
  type Run,
  type SessionKind,
  type Space,
  type WorkerNode,
} from '@meepo/core';
import {
  WORKER_CHANNEL_EVENTS,
  type DeliveryMode,
  type ImageReference,
  type DispatchSource,
  type ModelConfig,
  type TicketDispatchEnvelope,
  type TurnDispatchEnvelope,
} from '@meepo/protocol';

import type { DispatchCommitter } from './dispatch-committer.js';
import { conflict, notFound, validation } from '../errors.js';
import { resolveModel, type ModelRegistry } from '../models/model-registry.js';
import type { RunRepository } from '../runs/run-repository.js';
import type { SessionRepository } from '../sessions/session-repository.js';
import type { TranscriptService } from '../sessions/transcript-service.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { TicketRepository } from '../tickets/ticket-repository.js';
import { formatUserMessage } from '@meepo/protocol';

import type { WorkerRepository } from '../workers/worker-repository.js';
import type { DispatchQueueRepository, QueuedDispatch } from './dispatch-queue-repository.js';
import type { WorkerSender } from './worker-sender.js';

export interface DispatchSessionTurnInput {
  sessionId: string;
  images?: ImageReference[];
  ingress?: { channelId: string; messageId: string };
  sourceId?: string;
  eventType?: string;
  prompt: string;
  source: DispatchSource;
  delivery: DeliveryMode;
  author?: string;
  authorOpenId?: string;
  chatLabel?: string;
  /** Snapshot excludes transcript entries at or after this timestamp */
  snapshotBefore?: number;
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
    private readonly models: ModelRegistry,
    private readonly committer?: DispatchCommitter,
    private readonly now: () => number = Date.now,
    private readonly leaseDurationMs = 45_000,
    private readonly onInterrupted?: (run: Run) => void,
    private readonly journal?: ExecutionJournal
  ) {}

  async hasProcessedMessage(channelId: string, messageId: string): Promise<boolean> {
    return this.committer?.hasProcessedMessage(channelId, messageId) ?? false;
  }

  async dispatchSessionTurn(input: DispatchSessionTurnInput): Promise<DispatchOutcome> {
    const session = await this.sessions.getById(input.sessionId);
    if (!session) throw notFound(`Session not found: ${input.sessionId}`);
    if (session.status === 'closed') throw conflict('Session is closed');
    const space = await this.spaces.getById(session.spaceId);
    if (!space) throw notFound(`Space not found: ${session.spaceId}`);

    const prompt = formatPromptWithSource(input.prompt, input.source, {
      author: input.author,
      authorOpenId: input.authorOpenId,
      chatLabel: input.chatLabel,
    });
    const turnTimestamp = this.now();
    const message = {
      role: 'user',
      images: input.images,
      author: input.author,
      authorOpenId: input.authorOpenId,
      chatLabel: input.chatLabel,
      content: input.prompt,
      timestamp: turnTimestamp,
    } as const;

    const workerId = session.boundWorkerId ?? (await this.bindSessionWorker(session.id, space));
    const envelope = this.buildTurnEnvelope(session.id, session.kind, space, {
      ...input,
      prompt,
      snapshotBefore: turnTimestamp,
    });
    const worker = await this.workers.getById(workerId);
    const online = worker && worker.status !== 'offline' && this.sender.isConnected(workerId);

    const sourceId =
      input.sourceId ??
      (input.source.kind === 'user_message' ? input.source.messageId : randomUUID());
    envelope.turnRef = { sessionId: session.id, sourceId };
    envelope.currentTime = turnTimestamp;
    envelope.images = input.images;
    const run: Run = {
      id: envelope.runId,
      work: { kind: 'turn', turnRef: envelope.turnRef },
      attempt: 1,
      workerId,
      status: online ? 'dispatched' : 'queued',
      leaseExpiresAt: online ? this.now() + this.leaseDurationMs : undefined,
      createdAt: this.now(),
      initiatorIds: input.authorOpenId ? [input.authorOpenId] : [],
      mergedSourceIds: [sourceId],
    };
    const { model: _model, ...storedEnvelope } = envelope;
    const queued: QueuedDispatch = {
      id: run.id,
      sessionId: session.id,
      envelope: storedEnvelope,
      queuedAt: this.now(),
    };
    if (this.committer) {
      const committed = this.committer.TxEnqueueTurn(
        run,
        queued,
        message,
        input.ingress,
        input.eventType
      );
      if (committed.duplicate) return { dispatched: false, queued: false, workerId };
      envelope.snapshotBeforeSeq = committed.seq;
    } else {
      await this.transcripts.appendMessage(session.id, message);
      await this.runs.save(run);
      await this.queue.enqueue(queued);
    }

    envelope.mediaNamespace = session.channelId;
    if (online) {
      this.sender.sendToWorker(workerId, {
        kind: 'notification',
        event: WORKER_CHANNEL_EVENTS.turnDispatch,
        payload: envelope,
      });
      return { dispatched: true, queued: false, workerId };
    }

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
    const model = this.resolveSpaceModel(space);
    if (!model) throw validation(`No model configured for space ${space.id} or server default`);

    const eligible = await this.eligibleWorkers(space, ticket.requiredTags);
    eligible.sort((a, b) => a.activeSlots / a.maxSlots - b.activeSlots / b.maxSlots);
    for (const worker of eligible) {
      const run: Run = {
        id: randomUUID(),
        work: { kind: 'ticket', ticketId: ticket.id },
        leaseExpiresAt: this.now() + this.leaseDurationMs,
        attempt: (await this.runs.latestAttempt(ticket.id)) + 1,
        workerId: worker.id,
        status: 'dispatched',
        createdAt: Date.now(),
      };
      const envelope: TicketDispatchEnvelope = {
        runId: run.id,
        ticketId: ticket.id,
        attempt: run.attempt,
        currentTime: this.now(),
        spaceId: space.id,
        objective: ticket.objective,
        contextSummary: ticket.contextSummary,
        systemPromptContribution: composeSystemPromptContribution(space),
        model,
        source: { kind: 'system' },
      };
      if (this.committer) {
        if (!this.committer.TxClaimTicket(ticket, run, worker.maxSlots)) continue;
      } else {
        await this.runs.save(run);
        ticket.status = 'claimed';
        ticket.attempt = run.attempt;
        ticket.assignedWorkerId = worker.id;
        ticket.updatedAt = this.now();
        await this.tickets.save(ticket);
      }
      this.sender.sendToWorker(worker.id, {
        kind: 'notification',
        event: WORKER_CHANNEL_EVENTS.ticketDispatch,
        payload: envelope,
      });

      return { dispatched: true, queued: false, workerId: worker.id };
    }
    return { dispatched: false, queued: false };
  }

  /** SQLite cancellation already fenced these runs; still abort their live worker executions. */
  async stopTicketExecutions(ticketId: string): Promise<void> {
    for (const run of await this.runs.listByTicket(ticketId)) {
      if (run.workerId && run.terminalReason === 'cancelled')
        this.sender.sendToWorker(run.workerId, {
          kind: 'notification',
          event: 'run.abort',
          payload: { runId: run.id },
        });
    }
  }

  /** Interrupts a nonterminal run and forwards run.abort; returns false if already terminal. */
  async abortRun(runId: string): Promise<boolean> {
    const run = this.journal
      ? this.journal.TxInterrupt(runId, 'interrupted', this.now())
      : await this.runs.getById(runId);
    if (!run || (!this.journal && isTerminalRun(run.status))) return false;
    if (!this.journal) {
      run.status = 'failed';
      run.terminalReason = 'interrupted';
      run.completedAt = this.now();
      await this.runs.save(run);
      await this.queue.delete(run.id);
    }
    this.onInterrupted?.(run);
    if (!run.workerId) return true;
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
  async flushSessionQueue(sessionId: string, workerId: string, recover = true): Promise<number> {
    const queued: QueuedDispatch[] = [];
    for (const item of await this.queue.listBySession(sessionId)) {
      const run = await this.runs.getById(item.envelope.runId);
      if (!run || isTerminalRun(run.status)) {
        await this.queue.delete(item.id);
        continue;
      }
      if (run.status === 'queued') queued.push(item);
      else if (recover && run.status === 'dispatched' && run.workerId === workerId) {
        const space = await this.spaces.getById(item.envelope.spaceId);
        const session = await this.sessions.getById(sessionId);
        if (space && session?.status !== 'closed')
          this.sender.sendToWorker(workerId, {
            kind: 'notification',
            event: WORKER_CHANNEL_EVENTS.turnDispatch,
            payload: {
              ...item.envelope,
              model: this.resolveSpaceModel(space),
              mediaNamespace: session?.channelId,
            },
          });
      }
    }
    if (queued.length === 0) return 0;
    const first = queued[0];
    const space = await this.spaces.getById(first.envelope.spaceId);
    if (!space) return 0;
    const merged = { ...mergeQueued(queued), model: this.resolveSpaceModel(space) };
    const { model: _model, ...storedMerged } = merged;
    let primary: Run | undefined;
    if (this.committer) {
      if (
        !this.committer.TxMergeQueue(
          queued,
          storedMerged,
          workerId,
          this.now() + this.leaseDurationMs,
          this.now()
        )
      )
        return 0;
      primary = await this.runs.getById(first.id);
    } else {
      await this.queue.enqueue({ ...first, envelope: storedMerged });
      const authors = new Set<string>();
      for (const item of queued) {
        const run = await this.runs.getById(item.envelope.runId);
        if (!run || isTerminalRun(run.status)) {
          await this.queue.delete(item.id);
          continue;
        }
        for (const id of run.initiatorIds ?? []) authors.add(id);
        run.status = item === first ? 'dispatched' : 'merged';
        run.leaseExpiresAt = this.now() + this.leaseDurationMs;
        run.workerId = workerId;
        if (item !== first) {
          run.mergedIntoRunId = first.envelope.runId;
          run.completedAt = this.now();
        }
        await this.runs.save(run);
        if (item !== first) await this.queue.delete(item.id);
      }
      primary = await this.runs.getById(first.envelope.runId);
      if (primary) {
        primary.initiatorIds = [...authors];
        primary.mergedSourceIds = merged.mergedSourceIds;
        await this.runs.save(primary);
      }
    }
    const session = await this.sessions.getById(sessionId);
    if (primary && !isTerminalRun(primary.status))
      this.sender.sendToWorker(workerId, {
        kind: 'notification',
        event: WORKER_CHANNEL_EVENTS.turnDispatch,
        payload: {
          ...merged,
          mediaNamespace: session?.channelId,
        },
      });
    return queued.length;
  }

  async flushConnectedQueues(): Promise<void> {
    for (const worker of await this.workers.list()) {
      if (worker.status !== 'offline' && this.sender.isConnected(worker.id))
        await this.flushWorkerQueues(worker.id, false);
    }
  }

  /** Delivers queues for every session pinned to a (re)connected worker. */
  async flushWorkerQueues(workerId: string, recover = true): Promise<number> {
    const sessionIds = await this.queue.listSessionIds();
    let flushed = 0;
    for (const sessionId of sessionIds) {
      const session = await this.sessions.getById(sessionId);
      if (session?.boundWorkerId !== workerId) continue;
      try {
        flushed += await this.flushSessionQueue(sessionId, workerId, recover);
      } catch (error) {
        // A missing model or stale binding in one space must not block all workers.
        console.error(`Queue delivery failed for session ${sessionId}`, error);
      }
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
      // worker is eligible; the turn queues at the worker.
      workerId = await this.pickSessionWorker(space);
      if (!workerId) throw validation(`No online worker enrolled for space ${space.id}`);
    }
    const expected = { ...session };
    session.boundWorkerId = workerId;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session, expected);
    return workerId;
  }

  private async pickSessionWorker(space: Space): Promise<string | undefined> {
    const candidates = (await this.workers.listServingSpace(space.id)).filter(
      (worker) =>
        worker.status !== 'offline' &&
        space.requiredTags.every((tag) => worker.tags.includes(tag)) &&
        this.sender.isConnected(worker.id)
    );
    return candidates.length ? candidates[randomInt(candidates.length)].id : undefined;
  }

  private async eligibleWorkers(space: Space, requiredTags: string[]): Promise<WorkerNode[]> {
    return (await this.workers.listServingSpace(space.id)).filter(
      (worker) =>
        worker.status !== 'offline' &&
        worker.activeSlots < worker.maxSlots &&
        [...space.requiredTags, ...requiredTags].every((tag) => worker.tags.includes(tag)) &&
        this.sender.isConnected(worker.id)
    );
  }

  private resolveSpaceModel(space: Space): ModelConfig {
    const modelId = space.model?.modelId ?? this.models.defaultModelId;
    if (!modelId) throw validation(`No model configured for space ${space.id} or server default`);
    const model = resolveModel(this.models, modelId, space.model?.thinkingLevel);
    if (!model) throw validation(`Unknown model in registry: ${modelId}`);
    return model;
  }

  private buildTurnEnvelope(
    sessionId: string,
    sessionKind: SessionKind,
    space: Space,
    input: DispatchSessionTurnInput
  ): TurnDispatchEnvelope {
    const model = this.resolveSpaceModel(space);
    if (!model) throw validation(`No model configured for space ${space.id} or server default`);
    return {
      runId: randomUUID(),
      sessionId,
      spaceId: space.id,
      sessionKind,
      prompt: input.prompt,
      source: input.source,
      delivery: input.delivery,
      snapshotBefore: input.snapshotBefore,
      systemPromptContribution: composeSystemPromptContribution(space),
      model,
    };
  }
}

function composeSystemPromptContribution(space: Space): string {
  return `You are Meepo, a general-purpose assistant in space ${JSON.stringify(space.name)}. ${space.description ?? ''}`;
}

function mergeQueued(queued: QueuedDispatch[]): Omit<TurnDispatchEnvelope, 'model'> {
  const latest = queued[0].envelope;
  if (queued.length === 1) return latest;
  const mergedPrompt = queued
    .map((item, index) => `[queued message ${index + 1}]\n${item.envelope.prompt}`)
    .join('\n\n');
  return {
    ...latest,
    prompt: mergedPrompt,
    images: queued.flatMap((q) => q.envelope.images ?? []),
    delivery: 'wait',
    mergedSourceIds: queued.flatMap(
      (q) => q.envelope.mergedSourceIds ?? [q.envelope.turnRef?.sourceId ?? q.id]
    ),
  };
}

/** Wraps schedule fires in an origin envelope so the agent knows why it woke. */
function formatPromptWithSource(
  prompt: string,
  source: DispatchSource,
  speaker?: { author?: string; authorOpenId?: string; chatLabel?: string }
): string {
  if (source.kind === 'schedule') {
    return (
      `<schedule-fire scheduleId="${source.scheduleId}" coalescedCount="${source.coalescedCount}" ` +
      `stale="${source.stale}">\n${prompt}\n</schedule-fire>`
    );
  }
  if (source.kind === 'user_message') {
    return formatUserMessage(prompt, speaker ?? {});
  }
  return prompt;
}
