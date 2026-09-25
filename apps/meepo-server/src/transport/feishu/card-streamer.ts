import type { WorkerStreamEvent } from '@meepo/protocol';

import type { SessionService } from '../../domain/sessions/session-service.js';
import type { StreamRenderHook } from '../../domain/sessions/stream-processor.js';
import type { FeishuClient } from './feishu-client.js';

const MARKDOWN_ELEMENT_ID = 'md';
const DEFAULT_FLUSH_INTERVAL_MS = 500;

interface CardTask {
  cardId?: string;
  text: string;
  sequence: number;
  dirty: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Serializes card operations so ordering survives async card creation. */
  queue: Promise<void>;
}

export interface CardStreamerDeps {
  client: FeishuClient;
  sessions: Pick<SessionService, 'getSession'>;
  flushIntervalMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Renders worker stream events into a Feishu streaming card per session task:
 * a CardKit entity card (schema 2.0, streaming_mode) is created on
 * task_started and sent into the session's thread; text deltas are
 * accumulated and pushed as full-text element updates on a throttle; the
 * terminal event flushes and closes streaming mode. Ticket tasks are skipped.
 */
export class CardStreamer {
  private readonly tasks = new Map<string, CardTask>();
  private readonly flushIntervalMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(private readonly deps: CardStreamerDeps) {
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.onError = deps.onError ?? (() => undefined);
  }

  /** StreamRenderHook-compatible entry point. */
  readonly handleEvent: StreamRenderHook = (event, ref) => {
    if (ref.kind !== 'session') return;
    this.track(event, ref.sessionId).catch(this.onError);
  };

  private async track(event: WorkerStreamEvent, sessionId: string): Promise<void> {
    switch (event.type) {
      case 'task_started':
        await this.startCard(event.taskId, sessionId);
        return;
      case 'text_delta': {
        const task = this.tasks.get(event.taskId);
        if (!task || task.closed) return;
        task.text += event.delta;
        task.dirty = true;
        this.scheduleFlush(event.taskId, task);
        return;
      }
      case 'task_completed':
        await this.finishCard(event.taskId, false);
        return;
      case 'task_failed':
        await this.finishCard(event.taskId, true, event.error);
        return;
      default:
        return;
    }
  }

  private async startCard(taskId: string, sessionId: string): Promise<void> {
    const task: CardTask = {
      text: '',
      sequence: 0,
      dirty: false,
      closed: false,
      queue: Promise.resolve(),
    };
    this.tasks.set(taskId, task);
    task.queue = task.queue.then(async () => {
      const session = await this.deps.sessions.getSession(sessionId);
      if (!session.anchorMessageId) {
        throw new Error(`session ${sessionId} has no reply anchor; cannot stream card`);
      }
      const cardId = await this.deps.client.createCard(buildStreamingCardJson());
      task.cardId = cardId;
      await this.deps.client.replyCard(session.anchorMessageId, cardId);
    });
    await task.queue;
  }

  private scheduleFlush(taskId: string, task: CardTask): void {
    if (task.timer) return;
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (task.closed || !task.dirty) return;
      task.dirty = false;
      this.enqueue(taskId, task, () => this.pushContent(task));
    }, this.flushIntervalMs);
  }

  private async finishCard(taskId: string, failed: boolean, error?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.closed = true;
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    if (failed) {
      task.text += `\n\n> ⚠️ 任务失败：${error ?? 'unknown error'}`;
      task.dirty = true;
    }
    this.enqueue(taskId, task, async () => {
      if (task.dirty) {
        task.dirty = false;
        await this.pushContent(task);
      }
      if (!task.cardId) return;
      task.sequence += 1;
      await this.deps.client.updateCardSettings(
        task.cardId,
        JSON.stringify({ config: { streaming_mode: false } }),
        task.sequence
      );
    });
    await task.queue;
    this.tasks.delete(taskId);
  }

  /** Chains an operation onto the task's queue, waiting for card creation first. */
  private enqueue(taskId: string, task: CardTask, op: () => Promise<void>): void {
    task.queue = task.queue.then(op).catch((err: unknown) => {
      this.tasks.delete(taskId);
      this.onError(err);
    });
  }

  private async pushContent(task: CardTask): Promise<void> {
    if (!task.cardId || !task.text) return;
    task.sequence += 1;
    await this.deps.client.updateCardContent(
      task.cardId,
      MARKDOWN_ELEMENT_ID,
      task.text,
      task.sequence,
      `${task.cardId}_${task.sequence}`
    );
  }
}

function buildStreamingCardJson(): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: { print_strategy: 'fast' },
      update_multi: true,
    },
    body: { elements: [{ tag: 'markdown', element_id: MARKDOWN_ELEMENT_ID, content: '' }] },
  });
}
