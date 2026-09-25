import type { WorkerStreamEvent } from '@meepo/protocol';

import type { SessionService } from '../../domain/sessions/session-service.js';
import type { StreamRenderHook } from '../../domain/sessions/stream-processor.js';
import type { FeishuClient } from './feishu-client.js';

const MARKDOWN_ELEMENT_ID = 'md';
const DEFAULT_FLUSH_INTERVAL_MS = 500;

interface CardRun {
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
 * Renders worker stream events into a Feishu streaming card per session run:
 * a CardKit entity card (schema 2.0, streaming_mode) is created on
 * run_started and sent into the session's thread; text deltas are
 * accumulated and pushed as full-text element updates on a throttle; the
 * terminal event flushes and closes streaming mode. Ticket runs are skipped.
 */
export class CardStreamer {
  private readonly runs = new Map<string, CardRun>();
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
      case 'run_started':
        await this.startCard(event.runId, sessionId);
        return;
      case 'text_delta': {
        const run = this.runs.get(event.runId);
        if (!run || run.closed) return;
        run.text += event.delta;
        run.dirty = true;
        this.scheduleFlush(event.runId, run);
        return;
      }
      case 'run_completed':
        await this.finishCard(event.runId, false);
        return;
      case 'run_failed':
        await this.finishCard(event.runId, true, event.error);
        return;
      default:
        return;
    }
  }

  private async startCard(runId: string, sessionId: string): Promise<void> {
    const run: CardRun = {
      text: '',
      sequence: 0,
      dirty: false,
      closed: false,
      queue: Promise.resolve(),
    };
    this.runs.set(runId, run);
    run.queue = run.queue.then(async () => {
      const session = await this.deps.sessions.getSession(sessionId);
      if (!session.anchorMessageId) {
        throw new Error(`session ${sessionId} has no reply anchor; cannot stream card`);
      }
      const cardId = await this.deps.client.createCard(buildStreamingCardJson());
      run.cardId = cardId;
      // main sessions (private chats) reply in the main flow; thread sessions
      // (group threads) reply inside their thread.
      await this.deps.client.replyCard(session.anchorMessageId, cardId, {
        replyInThread: session.kind !== 'main',
      });
    });
    await run.queue;
  }

  private scheduleFlush(runId: string, run: CardRun): void {
    if (run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      if (run.closed || !run.dirty) return;
      run.dirty = false;
      this.enqueue(runId, run, () => this.pushContent(run));
    }, this.flushIntervalMs);
  }

  private async finishCard(runId: string, failed: boolean, error?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.closed = true;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = undefined;
    }
    if (failed) {
      run.text += `\n\n> ⚠️ 任务失败：${error ?? 'unknown error'}`;
      run.dirty = true;
    }
    this.enqueue(runId, run, async () => {
      if (run.dirty) {
        run.dirty = false;
        await this.pushContent(run);
      }
      if (!run.cardId) return;
      run.sequence += 1;
      await this.deps.client.updateCardSettings(
        run.cardId,
        JSON.stringify({ config: { streaming_mode: false } }),
        run.sequence
      );
    });
    await run.queue;
    this.runs.delete(runId);
  }

  /** Chains an operation onto the run's queue, waiting for card creation first. */
  private enqueue(runId: string, run: CardRun, op: () => Promise<void>): void {
    run.queue = run.queue.then(op).catch((err: unknown) => {
      this.runs.delete(runId);
      this.onError(err);
    });
  }

  private async pushContent(run: CardRun): Promise<void> {
    if (!run.cardId || !run.text) return;
    run.sequence += 1;
    await this.deps.client.updateCardContent(
      run.cardId,
      MARKDOWN_ELEMENT_ID,
      run.text,
      run.sequence,
      `${run.cardId}_${run.sequence}`
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
