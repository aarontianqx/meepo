import type { WorkerStreamEvent } from '@meepo/protocol';

import type { TicketService } from '../tickets/ticket-service.js';
import type { TranscriptService } from './transcript-service.js';

type TaskRef = { kind: 'session'; sessionId: string } | { kind: 'ticket'; ticketId: string };

/** Listener for renderable stream updates (Feishu card streaming); set by the IM layer. */
export type StreamRenderHook = (event: WorkerStreamEvent, ref: TaskRef) => void;

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/**
 * Consumes worker stream events: tracks task→session/ticket mappings,
 * accumulates assistant output, and finalizes transcripts and tickets at
 * turn boundaries. Exactly one terminal event settles each task.
 */
export class StreamProcessor {
  private readonly tasks = new Map<string, TaskRef>();
  private readonly buffers = new Map<string, string>();
  private renderHook?: StreamRenderHook;

  constructor(
    private readonly transcripts: TranscriptService,
    private readonly ticketService: TicketService,
    private readonly logger: Logger = console
  ) {}

  setRenderHook(hook: StreamRenderHook): void {
    this.renderHook = hook;
  }

  onEvent(event: WorkerStreamEvent): void {
    const ref = this.track(event);
    if (ref && this.renderHook) this.renderHook(event, ref);
    switch (event.type) {
      case 'text_delta':
        this.buffers.set(event.taskId, (this.buffers.get(event.taskId) ?? '') + event.delta);
        return;
      case 'task_completed':
        void this.settle(event.taskId, event.resultSummary ?? '', true).catch((err: unknown) => {
          this.logger.error(`failed to settle task ${event.taskId}`, err);
        });
        return;
      case 'task_failed':
        void this.settle(event.taskId, event.error, false).catch((err: unknown) => {
          this.logger.error(`failed to settle task ${event.taskId}`, err);
        });
        return;
      default:
        return;
    }
  }

  private track(event: WorkerStreamEvent): TaskRef | undefined {
    if (event.type === 'task_started') {
      const ref: TaskRef | undefined = event.sessionId
        ? { kind: 'session', sessionId: event.sessionId }
        : event.ticketId
          ? { kind: 'ticket', ticketId: event.ticketId }
          : undefined;
      if (ref) {
        this.tasks.set(event.taskId, ref);
        if (ref.kind === 'ticket') {
          void this.ticketService
            .markRunning(ref.ticketId, event.workerId)
            .catch((err: unknown) => {
              this.logger.error(`failed to mark ticket ${ref.ticketId} running`, err);
            });
        }
      }
      return ref;
    }
    return this.tasks.get(event.taskId);
  }

  private async settle(taskId: string, finalText: string, ok: boolean): Promise<void> {
    const ref = this.tasks.get(taskId);
    const buffered = this.buffers.get(taskId) ?? '';
    this.tasks.delete(taskId);
    this.buffers.delete(taskId);
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
