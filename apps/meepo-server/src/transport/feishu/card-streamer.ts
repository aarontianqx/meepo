import type { WorkerStreamEvent } from '@meepo/protocol';

import type { SessionService } from '../../domain/sessions/session-service.js';
import type { StreamRenderHook } from '../../domain/sessions/stream-processor.js';
import type { FeishuClient } from './feishu-client.js';

const MARKDOWN_ELEMENT_ID = 'md';
const DEFAULT_FLUSH_INTERVAL_MS = 500;

interface CardRun {
  cardId?: string;
  thinking: string;
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

type CardState = 'streaming' | 'completed' | 'failed';

/**
 * Renders worker stream events into a single Feishu card per run: the card is
 * the placeholder from the start (the prewarm reply is deleted when streaming
 * begins), thinking deltas accumulate into a collapsible panel, and at the
 * terminal event the card is replaced with its final content — thinking kept
 * collapsed, button removed, streaming mode closed. Ticket runs are skipped.
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
        this.scheduleFlush(event.runId, run);
        return;
      }
      case 'thinking_delta': {
        const run = this.runs.get(event.runId);
        if (!run || run.closed) return;
        run.thinking += event.delta;
        this.scheduleFlush(event.runId, run);
        return;
      }
      case 'run_completed':
        await this.finishCard(event.runId, 'completed');
        return;
      case 'run_failed':
        await this.finishCard(event.runId, 'failed', event.error);
        return;
      default:
        return;
    }
  }

  private async startCard(runId: string, sessionId: string): Promise<void> {
    const run: CardRun = {
      thinking: '',
      text: '',
      sequence: 0,
      dirty: false,
      closed: false,
      queue: Promise.resolve(),
    };
    this.runs.set(runId, run);
    run.queue = run.queue.then(async () => {
      const session = await this.deps.sessions.getSession(sessionId);
      if (session.prewarmMessageId) {
        await this.deps.client.deleteMessage(session.prewarmMessageId).catch(() => undefined);
      }
      if (!session.anchorMessageId) {
        throw new Error(`session ${sessionId} has no reply anchor; cannot stream card`);
      }
      const cardId = await this.deps.client.createCard(buildCardJson(run, runId, 'streaming'));
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
    run.dirty = true;
    if (run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      if (run.closed || !run.dirty) return;
      run.dirty = false;
      this.enqueue(runId, run, () => this.pushCard(run, 'streaming'));
    }, this.flushIntervalMs);
  }

  private async finishCard(
    runId: string,
    state: 'completed' | 'failed',
    error?: string
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.closed = true;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = undefined;
    }
    if (state === 'failed') {
      run.text += `\n\n> ⚠️ 任务失败：${error ?? 'unknown error'}`;
    }
    this.enqueue(runId, run, async () => {
      await this.pushCard(run, state);
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

  private async pushCard(run: CardRun, state: CardState): Promise<void> {
    if (!run.cardId) return;
    run.sequence += 1;
    await this.deps.client.updateCard(
      run.cardId,
      buildCardJson(run, run.cardId, state),
      run.sequence,
      `${run.cardId}_${run.sequence}`
    );
  }
}

function buildCardJson(run: CardRun, runId: string, state: CardState): string {
  const elements: Record<string, unknown>[] = [];
  if (run.thinking) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: state === 'streaming' ? '💭 思考中' : '✅ 思考完成',
        },
      },
      border: { color: 'grey' },
      background_color: 'grey',
      elements: [{ tag: 'markdown', content: run.thinking }],
    });
  }
  elements.push({ tag: 'markdown', element_id: MARKDOWN_ELEMENT_ID, content: run.text });
  if (state === 'streaming') {
    elements.push({
      tag: 'button',
      name: 'abort_run',
      text: { tag: 'lark_md', content: '停止' },
      type: 'danger',
      value: { action: 'abort_run', runId },
    });
  }
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: { print_strategy: 'fast' },
      update_multi: true,
    },
    body: { elements },
  });
}
