import type { Run } from '@meepo/core';
import type { WorkerStreamEvent } from '@meepo/protocol';

import type { RunRepository } from '../runs/run-repository.js';
import type { TicketService } from '../tickets/ticket-service.js';
import type { TranscriptService } from './transcript-service.js';

type WorkRef = { kind: 'session'; sessionId: string } | { kind: 'ticket'; ticketId: string };

/** Listener for renderable stream updates (Feishu card streaming); set by the IM layer. */
export type StreamRenderHook = (event: WorkerStreamEvent, ref: WorkRef) => void;

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

type RunStartedEvent = Extract<WorkerStreamEvent, { type: 'run_started' }>;

/**
 * Consumes worker stream events: tracks run→session/ticket mappings,
 * accumulates assistant output, advances Run state, and finalizes transcripts
 * and tickets at run boundaries. Exactly one terminal event settles each run.
 */
export class StreamProcessor {
  private readonly refs = new Map<string, WorkRef>();
  private readonly buffers = new Map<string, string>();
  /** Serializes async per-run work so started always lands before settle. */
  private readonly chains = new Map<string, Promise<void>>();
  private renderHook?: StreamRenderHook;

  constructor(
    private readonly transcripts: TranscriptService,
    private readonly ticketService: TicketService,
    private readonly runs: RunRepository,
    private readonly logger: Logger = console
  ) {}

  setRenderHook(hook: StreamRenderHook): void {
    this.renderHook = hook;
  }

  onEvent(event: WorkerStreamEvent): void {
    switch (event.type) {
      case 'run_started': {
        // Track and render synchronously so immediately following deltas land.
        const ref = refOfEvent(event);
        if (ref) this.refs.set(event.runId, ref);
        if (ref && this.renderHook) this.renderHook(event, ref);
        this.enqueue(event.runId, () => this.onStarted(event));
        return;
      }
      case 'text_delta':
        this.buffers.set(event.runId, (this.buffers.get(event.runId) ?? '') + event.delta);
        this.notify(event);
        return;
      case 'run_completed':
        this.notify(event);
        this.enqueue(event.runId, () => this.settle(event.runId, event.resultSummary ?? '', true));
        return;
      case 'run_failed':
        this.notify(event);
        this.enqueue(event.runId, () => this.settle(event.runId, event.error, false));
        return;
      default:
        this.notify(event);
        return;
    }
  }

  /** Async side of run_started: advance the Run record and reconcile the ref. */
  private async onStarted(event: RunStartedEvent): Promise<void> {
    const run = await this.runs.getById(event.runId);
    const ref = refOfRun(run) ?? this.refs.get(event.runId);
    if (ref) this.refs.set(event.runId, ref);
    if (run && run.status !== 'completed' && run.status !== 'failed') {
      run.status = 'running';
      run.workerId = event.workerId;
      run.startedAt = Date.now();
      await this.runs.save(run);
    }
    if (ref?.kind === 'ticket') {
      try {
        await this.ticketService.markRunning(ref.ticketId, event.workerId);
      } catch (err: unknown) {
        this.logger.error(`failed to mark ticket ${ref.ticketId} running`, err);
      }
    }
  }

  private notify(event: WorkerStreamEvent): void {
    const ref = this.refs.get(event.runId);
    if (ref && this.renderHook) this.renderHook(event, ref);
  }

  private enqueue(runId: string, op: () => Promise<void>): void {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(op).catch((err: unknown) => {
      this.logger.error(`failed to process run ${runId}`, err);
    });
    this.chains.set(runId, next);
    void next.finally(() => {
      if (this.chains.get(runId) === next) this.chains.delete(runId);
    });
  }

  private async settle(runId: string, finalText: string, ok: boolean): Promise<void> {
    const run = await this.runs.getById(runId);
    const ref = this.refs.get(runId) ?? refOfRun(run);
    const buffered = this.buffers.get(runId) ?? '';
    this.refs.delete(runId);
    this.buffers.delete(runId);

    if (run && run.status !== 'completed' && run.status !== 'failed') {
      run.status = ok ? 'completed' : 'failed';
      run.completedAt = Date.now();
      await this.runs.save(run);
    }
    if (!ref) return;

    const content = buffered || finalText;
    if (ref.kind === 'session') {
      await this.transcripts.appendMessage(ref.sessionId, {
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });
      return;
    }
    if (ok) {
      await this.ticketService.completeTicket(ref.ticketId, { summary: content });
    } else {
      await this.ticketService.failTicket(ref.ticketId, finalText);
    }
  }
}

/** Resolves the work ref from the persisted Run (survives server restarts). */
function refOfRun(run: Run | undefined): WorkRef | undefined {
  if (!run) return undefined;
  return run.work.kind === 'ticket'
    ? { kind: 'ticket', ticketId: run.work.ticketId }
    : { kind: 'session', sessionId: run.work.sessionId };
}

/** Falls back to the event's own hints when no Run record exists. */
function refOfEvent(event: RunStartedEvent): WorkRef | undefined {
  if (event.sessionId) return { kind: 'session', sessionId: event.sessionId };
  if (event.ticketId) return { kind: 'ticket', ticketId: event.ticketId };
  return undefined;
}
