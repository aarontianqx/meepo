import { createHash } from 'node:crypto';
import type { SessionService } from '../../domain/sessions/session-service.js';
import type { StreamRenderHook } from '../../domain/sessions/stream-processor.js';
import type { CardProjection, CardOutbox } from '../../domain/outbound/card-outbox.js';
import type { FeishuClient } from './feishu-client.js';

const PAGE_LENGTH = 30000;
interface LiveCard {
  revision: number;
  state: CardProjection;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
export interface CardStreamerDeps {
  client: FeishuClient;
  sessions: Pick<SessionService, 'getSession'>;
  flushIntervalMs?: number;
  isUserRun?: (runId: string) => Promise<boolean>;
  channelId?: string;
  outbox?: CardOutbox;
  onError?: (err: unknown) => void;
}
/** A durable rendering projection. Network retries never choose a new reply UUID. */
export class CardStreamer {
  private readonly runs = new Map<string, LiveCard>();
  private stopped = false;
  constructor(private readonly deps: CardStreamerDeps) {}
  readonly handleEvent: StreamRenderHook = (event, ref) => {
    if (ref.kind !== 'session' || this.stopped) return;
    let live = this.runs.get(event.runId);
    if (!live) {
      const old = this.deps.outbox?.get(event.runId);
      live = {
        revision: 0,
        state: old ?? {
          runId: event.runId,
          sessionId: ref.sessionId,
          channelId: this.deps.channelId ?? '',
          text: '',
          thinking: '',
          tools: {},
          sequence: 0,
          part: 0,
          offset: 0,
          state: 'streaming',
          dirty: false,
          updatedAt: Date.now(),
        },
        queue: Promise.resolve(),
      };
      this.runs.set(event.runId, live);
    }
    const p = live.state;
    if (p.state !== 'streaming') return;
    switch (event.type) {
      case 'text_delta':
        if (p.committedTextLength && p.text.length === p.committedTextLength) p.text += '\n\n';
        p.text += event.delta;
        break;
      case 'thinking_delta':
        p.thinking = (p.thinking + event.delta).slice(-6000);
        break;
      case 'assistant_text':
        p.text =
          p.text.slice(0, p.committedTextLength ?? 0) +
          (p.committedTextLength ? '\n\n' : '') +
          event.content;
        p.committedTextLength = p.text.length;
        break;
      case 'tool_execution_start':
        p.tools[event.toolCallId] = { name: event.toolName, state: 'running' };
        break;
      case 'tool_execution_end':
        if (p.tools[event.toolCallId])
          p.tools[event.toolCallId].state = event.isError ? 'failed' : 'completed';
        break;
      case 'run_completed':
        p.state = 'completed';
        if (!p.text && event.resultSummary) p.text = event.resultSummary;
        break;
      case 'run_failed':
        p.state = 'failed';
        p.failure = event.error;
        break;
      default:
        return;
    }
    live.revision++;
    p.dirty = true;
    this.persist(p);
    if (p.state !== 'streaming') {
      if (live.timer) clearTimeout(live.timer);
      live.timer = undefined;
      this.enqueue(live);
    } else this.schedule(live);
  };
  recover(): void {
    for (const p of this.deps.outbox?.listPending(this.deps.channelId ?? '') ?? []) {
      const existing = this.runs.get(p.runId);
      if (existing) {
        if (p.state !== 'streaming' && existing.state.state === 'streaming') {
          existing.state = p;
          existing.revision++;
          this.enqueue(existing);
        }
        continue;
      }
      const live: LiveCard = { revision: 0, state: p, queue: Promise.resolve() };
      this.runs.set(p.runId, live);
      if (p.dirty) this.enqueue(live);
    }
  }
  stop(): void {
    this.stopped = true;
    for (const live of this.runs.values()) if (live.timer) clearTimeout(live.timer);
  }
  private persist(p: CardProjection): void {
    p.updatedAt = Date.now();
    this.deps.outbox?.save(p);
  }
  private schedule(live: LiveCard, delay = this.deps.flushIntervalMs ?? 500): void {
    if (live.timer || this.stopped) return;
    live.timer = setTimeout(() => {
      live.timer = undefined;
      this.enqueue(live);
    }, delay);
    live.timer.unref?.();
  }
  private enqueue(live: LiveCard): void {
    live.queue = live.queue
      .then(() => this.flush(live))
      .catch((error) => {
        this.deps.onError?.(error);
        this.schedule(live, 2000);
      });
  }
  private async flush(live: LiveCard): Promise<void> {
    const p = live.state;
    if (this.stopped || !p.dirty) return;
    if (p.failure) {
      if (p.text || p.thinking || ((await this.deps.isUserRun?.(p.runId)) ?? true))
        p.text += `\n\n> ⚠️ 任务失败：${p.failure}`;
      p.failure = undefined;
    }
    if (!p.text && !p.thinking) {
      p.dirty = false;
      this.persist(p);
      if (p.state !== 'streaming') this.runs.delete(p.runId);
      return;
    }
    const session = await this.deps.sessions.getSession(p.sessionId);
    if (!session.anchorMessageId) {
      p.dirty = false;
      this.persist(p);
      if (p.state !== 'streaming') this.runs.delete(p.runId);
      return;
    }
    // Snapshot the visible generation; further deltas stay dirty while I/O is in flight.
    const version = live.revision;
    do {
      const continuing = p.text.length - p.offset > PAGE_LENGTH;
      const state = continuing ? 'completed' : p.state;
      const content = p.text.slice(p.offset, p.offset + PAGE_LENGTH);
      const json = buildCardJson(p, content, state, continuing);
      if (!p.cardId) {
        p.cardId = await this.deps.client.createCard(json);
        this.persist(p);
      }
      if (!p.replied) {
        const uuid = createHash('sha256')
          .update(`${p.channelId}:${p.runId}:${p.part}`)
          .digest('hex')
          .slice(0, 40);
        const alreadySent =
          p.sendStartedAt &&
          (await this.deps.client.findReply?.({
            chatId: session.chatId!,
            threadId: session.kind === 'thread' ? session.threadId : undefined,
            parentId: session.anchorMessageId,
            since: p.sendStartedAt,
            cardId: p.cardId,
          }));
        if (!alreadySent) {
          p.sendStartedAt ??= Date.now();
          this.persist(p);
          await this.deps.client.replyCard(session.anchorMessageId, p.cardId, {
            replyInThread: session.kind !== 'main',
            uuid,
          });
        }
        p.replied = true;
        this.persist(p);
        if (session.prewarmMessageId)
          await this.deps.client.deleteMessage(session.prewarmMessageId).catch(() => undefined);
      }
      // Persist the reserved sequence before sending. Retrying with a larger sequence is safe.
      p.sequence++;
      this.persist(p);
      await this.deps.client.updateCard(p.cardId, json, p.sequence, `${p.cardId}_${p.sequence}`);
      if (state !== 'streaming') {
        p.sequence++;
        this.persist(p);
        await this.deps.client.updateCardSettings(
          p.cardId,
          JSON.stringify({ config: { streaming_mode: false } }),
          p.sequence
        );
      }
      if (!continuing) break;
      p.offset += PAGE_LENGTH;
      p.part++;
      p.cardId = undefined;
      p.replied = false;
      p.sendStartedAt = undefined;
      p.sequence = 0;
      this.persist(p);
    } while (!this.stopped);
    p.dirty = live.revision !== version;
    this.persist(p);
    if (p.dirty) this.schedule(live);
    if (p.state !== 'streaming' && !p.dirty) this.runs.delete(p.runId);
  }
}
function buildCardJson(
  p: CardProjection,
  text: string,
  state: CardProjection['state'],
  continuing: boolean
): string {
  const elements: Record<string, unknown>[] = [];
  if (p.thinking)
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: state === 'streaming' ? '💭 思考中' : '思考过程' },
      },
      border: { color: 'grey' },
      elements: [{ tag: 'markdown', content: p.thinking }],
    });
  const tools = Object.values(p.tools).slice(-10);
  if (tools.length)
    elements.push({
      tag: 'markdown',
      content: tools
        .map(
          (t) => `${t.state === 'running' ? '⏳' : t.state === 'failed' ? '⚠️' : '✓'} \`${t.name}\``
        )
        .join(' · '),
    });
  if (text) elements.push({ tag: 'markdown', element_id: 'md', content: text });
  if (continuing) elements.push({ tag: 'markdown', content: '↓ 内容较长，后续见下一张卡片' });
  if (state === 'streaming')
    elements.push({
      tag: 'button',
      name: 'abort_run',
      text: { tag: 'lark_md', content: '停止' },
      type: 'danger',
      value: { action: 'abort_run', runId: p.runId },
    });
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: state === 'streaming',
      streaming_config: { print_strategy: 'fast' },
      update_multi: true,
    },
    body: { elements },
  });
}
