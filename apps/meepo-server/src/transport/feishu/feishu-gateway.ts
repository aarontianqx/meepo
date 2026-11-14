import type { InboundInbox } from '../../domain/im/inbound-inbox.js';
import { createHash } from 'node:crypto';

import type { Session } from '@meepo/core';
import { formatQuotedMessage } from '@meepo/protocol';
import type { DispatchOutcome, DispatchService } from '../../domain/dispatch/dispatch-service.js';
import { NoOnlineWorkerError } from '../../domain/errors.js';
import {
  decideInbound,
  GROUP_MAIN_SUB_ID,
  windowIdOf,
  type InboundDecision,
  type InboundMessage,
} from '../../domain/im/im-router.js';
import type { RunRepository } from '../../domain/runs/run-repository.js';
import type { SessionService } from '../../domain/sessions/session-service.js';
import type { TranscriptService } from '../../domain/sessions/transcript-service.js';
import type { SpaceRepository } from '../../domain/spaces/space-repository.js';
import { DedupCache } from './dedup-cache.js';
import type { FeishuCardActionEvent, FeishuClient, FeishuMessageEvent } from './feishu-client.js';
import { parsePostContent } from './post-content.js';

const MESSAGE_DEDUP_TTL_MS = 30 * 60 * 1000;
const PREWARM_TEXT = '正在处理，请稍候…';
const WORKER_OFFLINE_TEXT = '当前没有在线的 worker，消息已排队，worker 恢复后会自动处理。';
const NEW_COMMAND = '/new';
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
const THREAD_SEED_LIMIT = 50;

export interface FeishuGatewayDeps {
  inbox?: InboundInbox;
  channelId?: string;
  channelSpaceId?: string;
  allowedOpenIds?: string[];
  boundChatIds?: string[];
  client: FeishuClient;
  sessionService: SessionService;
  dispatchService: DispatchService;
  transcriptService: TranscriptService;
  spaces: SpaceRepository;
  runs: RunRepository;
  botOpenId: string;
  defaultSpaceId?: string;
  dedup?: DedupCache;
  onError?: (err: unknown) => void;
}

/**
 * Feishu IM transport: normalizes inbound events, runs the pure decision
 * chain from `domain/im`, then executes the dispatch (prewarm / thread / p2p)
 * against the domain services. All Feishu I/O goes through the narrow
 * {@link FeishuClient} port.
 */
export class FeishuGateway {
  private readonly dedup: DedupCache;
  /** windowId -> sessionId for every window this gateway has engaged. */
  private readonly windowSessions = new Map<string, string>();
  /** Messages already told that no worker is online; their retries stay quiet. */
  private readonly offlineNoticed = new Set<string>();
  private readonly onError: (err: unknown) => void;

  constructor(private readonly deps: FeishuGatewayDeps) {
    this.dedup = deps.dedup ?? new DedupCache(MESSAGE_DEDUP_TTL_MS);
    this.onError = deps.onError ?? (() => undefined);
  }

  /** Entry point for the raw WS event. Never throws. */
  async handleEvent(event: FeishuMessageEvent): Promise<void> {
    try {
      const msg = normalizeMessage(event, this.deps.botOpenId);
      if (!msg) return;
      await this.handleInbound(msg);
    } catch (err: unknown) {
      this.report(err);
    }
  }

  /**
   * Re-delivers group messages from the last 24 hours that arrived while the
   * server was down. The normal pipeline filters them: already processed
   * messages are deduplicated, and only @bot or engaged-thread messages
   * dispatch. Commands and unreadable types are not replayed.
   */
  async backfill(): Promise<void> {
    const since = Date.now() - BACKFILL_WINDOW_MS;
    for (const chatId of (await this.chatSpaceMap()).keys()) {
      try {
        for (const event of (await this.deps.client.listRecentMessages?.(chatId, since)) ?? []) {
          const msg = normalizeMessage(event, this.deps.botOpenId);
          if (!msg || msg.unsupportedType || isNewCommand(msg)) continue;
          try {
            await this.handleInbound(msg);
          } catch (err: unknown) {
            this.report(err);
          }
        }
      } catch (err: unknown) {
        this.report(err);
      }
    }
  }

  async recover(): Promise<void> {
    for (const message of this.deps.inbox?.pending(this.deps.channelId ?? 'feishu') ?? []) {
      try {
        await this.handleInbound(message);
      } catch (error) {
        this.report(error);
      }
    }
  }
  private readonly inbound = new Map<string, Promise<void>>();
  handleInbound(msg: InboundMessage): Promise<void> {
    const pending = this.inbound.get(msg.messageId);
    if (pending) return pending;
    const channel = this.deps.channelId ?? 'feishu';
    this.deps.inbox?.put(channel, msg);
    const task = this.processInbound(msg)
      .then(() => this.deps.inbox?.done(channel, msg.messageId))
      .finally(() => this.inbound.delete(msg.messageId));
    this.inbound.set(msg.messageId, task);
    return task;
  }
  private async processInbound(msg: InboundMessage): Promise<void> {
    if (this.dedup.has(msg.messageId)) return;
    if (
      this.deps.channelId &&
      (await this.deps.dispatchService.hasProcessedMessage(this.deps.channelId, msg.messageId))
    )
      return;
    if (
      msg.chatType === 'p2p' &&
      this.deps.allowedOpenIds?.length &&
      !this.deps.allowedOpenIds.includes(msg.senderOpenId)
    )
      return;

    const spaceByChat = await this.chatSpaceMap();
    const spaceId = msg.chatType === 'p2p' ? this.deps.defaultSpaceId : spaceByChat.get(msg.chatId);
    if (spaceId && msg.threadId) await this.warmThreadWindow(spaceId, msg.chatId, msg.threadId);

    if (
      isNewCommand(msg) &&
      spaceId &&
      (msg.chatType === 'p2p' || msg.mentionedOpenIds.includes(this.deps.botOpenId))
    ) {
      await this.handleNewCommand(msg);
      this.dedup.add(msg.messageId);
      return;
    }

    const decision = decideInbound(msg, {
      botOpenId: this.deps.botOpenId,
      channelId: this.deps.channelId,
      defaultSpaceId: this.deps.defaultSpaceId,
      spaceIdForChat: (chatId) => spaceByChat.get(chatId),
      sessionExistsForWindow: (windowId) => this.windowSessions.has(windowId),
      seenMessage: (messageId) => this.dedup.has(messageId),
    });
    if (decision.action === 'ignore') return;
    if (msg.unsupportedType) {
      await this.deps.client.replyText(
        msg.messageId,
        `暂不支持「${msg.unsupportedType}」类型的消息，请改用文字、图片或富文本。`,
        { uuid: this.idempotencyKey(msg.messageId, 'unsupported') }
      );
      this.dedup.add(msg.messageId);
      return;
    }
    let outcome: DispatchOutcome;
    try {
      outcome = await this.executeDispatch(msg, decision);
    } catch (err: unknown) {
      // The inbox keeps the message pending and the recover loop retries it.
      if (err instanceof NoOnlineWorkerError && !this.offlineNoticed.has(msg.messageId)) {
        this.offlineNoticed.add(msg.messageId);
        await this.noticeWorkerOffline(msg, decision.sessionKind);
      }
      throw err;
    }
    this.offlineNoticed.delete(msg.messageId);
    if (outcome.queued) await this.noticeWorkerOffline(msg, decision.sessionKind);
    this.dedup.add(msg.messageId);
  }

  /** Retried "no worker" failures are an expected waiting state, not errors to log every tick. */
  private report(err: unknown): void {
    if (!(err instanceof NoOnlineWorkerError)) this.onError(err);
  }

  private async noticeWorkerOffline(
    msg: InboundMessage,
    sessionKind: 'main' | 'thread'
  ): Promise<void> {
    try {
      await this.deps.client.replyText(msg.messageId, WORKER_OFFLINE_TEXT, {
        // Thread messages already live in their thread; only a fresh main-stream mention opens one.
        replyInThread: sessionKind === 'thread' && !msg.threadId,
        uuid: this.idempotencyKey(msg.messageId, 'worker-offline'),
      });
    } catch (err: unknown) {
      this.onError(err);
    }
  }

  private idempotencyKey(messageId: string, purpose: string): string {
    return createHash('sha256')
      .update(`${this.deps.channelId}:${messageId}:${purpose}`)
      .digest('hex')
      .slice(0, 40);
  }

  /** Handles `card.action.trigger`: only the run's initiating users may abort it. */
  async handleCardAction(event: FeishuCardActionEvent): Promise<void> {
    try {
      const value = event.action?.value;
      if (value?.action !== 'abort_run' || !value.runId) return;
      const run = await this.deps.runs.getById(value.runId);
      if (!run || run.work.kind !== 'turn') return;
      const session = await this.deps.sessionService.getSession(run.work.turnRef.sessionId);
      if (this.deps.channelId && session.channelId !== this.deps.channelId) return;
      const operator = event.operator?.open_id;
      if (!operator || !run.initiatorIds?.includes(operator)) return;
      await this.deps.dispatchService.abortRun(value.runId);
    } catch (err: unknown) {
      this.onError(err);
    }
  }

  /** Sends a plain notification to a session's window (ticket results, system notices). */
  async notifySession(sessionId: string, text: string): Promise<void> {
    try {
      const session = await this.deps.sessionService.getSession(sessionId);
      if (!session.anchorMessageId) return;
      await this.deps.client.replyText(session.anchorMessageId, text, {
        replyInThread: session.kind !== 'main',
      });
    } catch (err: unknown) {
      this.onError(err);
    }
  }

  private async handleNewCommand(msg: InboundMessage): Promise<void> {
    const isMainWindow = msg.chatType === 'p2p' || !msg.threadId;
    if (!isMainWindow) {
      await this.deps.client.replyText(
        msg.messageId,
        '话题内不支持 /new（话题过长时会自动压缩）。'
      );
      return;
    }
    const windowId =
      msg.chatType === 'p2p'
        ? windowIdOf(msg.chatId, msg.senderOpenId, this.deps.channelId)
        : windowIdOf(msg.chatId, GROUP_MAIN_SUB_ID, this.deps.channelId);
    let sessionId = this.windowSessions.get(windowId);
    if (!sessionId) {
      const spaces = await this.chatSpaceMap();
      const spaceId = msg.chatType === 'p2p' ? this.deps.defaultSpaceId : spaces.get(msg.chatId);
      if (spaceId)
        sessionId = (
          await this.deps.sessionService.findByThread(
            spaceId,
            msg.chatId,
            msg.chatType === 'p2p' ? msg.senderOpenId : GROUP_MAIN_SUB_ID,
            this.deps.channelId
          )
        )?.id;
    }
    if (!sessionId) {
      await this.deps.client.replyText(msg.messageId, '当前窗口没有进行中的会话。');
      return;
    }
    const reset = await this.deps.sessionService.reset(sessionId, msg.messageId, {
      channelId: this.deps.channelId ?? 'feishu',
      messageId: msg.messageId,
    });
    if (reset) {
      this.windowSessions.set(windowId, reset.id);
      return;
    }
    const previous = await this.deps.sessionService.getSession(sessionId);
    await this.deps.sessionService.close(sessionId);
    for (const [key, value] of this.windowSessions) {
      if (value === sessionId) this.windowSessions.delete(key);
    }
    const fresh = await this.deps.sessionService.getOrCreateByThread({
      spaceId: previous.spaceId,
      channelId: previous.channelId,
      chatId: previous.chatId,
      threadId: previous.threadId,
      kind: previous.kind,
      anchorMessageId: msg.messageId,
    });
    this.windowSessions.set(windowId, fresh.id);
    await this.deps.client.replyText(msg.messageId, '已关闭当前会话并开启新会话。');
  }

  private async executeDispatch(
    msg: InboundMessage,
    decision: Extract<InboundDecision, { action: 'dispatch' }>
  ): Promise<DispatchOutcome> {
    let threadId: string;
    let anchorMessageId: string;
    let prewarmMessageId: string | undefined;
    const spawned =
      decision.threadRef.kind === 'prewarm'
        ? await this.spawnedSession(decision.windowId)
        : undefined;
    if (spawned) {
      // A retry after a failed dispatch: the thread and prewarm reply already exist.
      threadId = spawned.threadId;
      anchorMessageId = spawned.anchorMessageId ?? msg.messageId;
      prewarmMessageId = spawned.prewarmMessageId;
    } else if (decision.threadRef.kind === 'prewarm') {
      const previous = await this.deps.client.findReply?.({
        chatId: msg.chatId,
        parentId: msg.messageId,
        since: Date.now() - 7 * 86400000,
        text: PREWARM_TEXT,
      });
      const reply =
        previous ??
        (await this.deps.client.replyText(msg.messageId, PREWARM_TEXT, {
          replyInThread: true,
          uuid: this.idempotencyKey(msg.messageId, 'prewarm'),
        }));
      threadId = reply.threadId ?? msg.messageId;
      anchorMessageId = msg.messageId;
      prewarmMessageId = reply.messageId || undefined;
    } else {
      threadId = decision.threadRef.threadId;
      anchorMessageId = msg.rootId ?? msg.messageId;
    }

    const sessionId = await this.resolveSession(decision.windowId, {
      spaceId: decision.spaceId,
      chatId: msg.chatId,
      threadId,
      kind: decision.sessionKind,
      anchorMessageId,
      prewarmMessageId,
    });
    this.windowSessions.set(decision.windowId, sessionId);
    this.windowSessions.set(windowIdOf(msg.chatId, threadId, this.deps.channelId), sessionId);

    if (decision.seedThreadHistory) {
      await this.seedThreadHistory(sessionId, threadId, msg.messageId);
    }

    let prompt = msg.text;
    if (msg.parentId) {
      const quoted = await this.deps.client.getMessage?.(msg.parentId);
      if (quoted && quoted.chatId === msg.chatId)
        prompt = formatQuotedMessage(
          { sender: quoted.sender, body: quoted.text.slice(0, 12000) },
          prompt
        );
    }
    return this.deps.dispatchService.dispatchSessionTurn({
      sessionId,
      ingress: { channelId: this.deps.channelId ?? 'feishu', messageId: msg.messageId },
      prompt,
      images: msg.images,
      source: { kind: 'user_message', messageId: msg.messageId },
      delivery: 'wait',
      author: (await this.deps.client.getUserName?.(msg.senderOpenId)) ?? msg.senderName,
      authorOpenId: msg.senderOpenId,
      chatLabel: await this.chatLabelOf(msg),
    });
  }

  private async chatLabelOf(msg: InboundMessage): Promise<string> {
    if (msg.chatType === 'p2p') return '私聊';
    return this.deps.client.getChatName(msg.chatId);
  }

  /** Imports pre-existing thread messages into a new session's transcript. */
  private async seedThreadHistory(
    sessionId: string,
    threadId: string,
    excludeMessageId: string
  ): Promise<void> {
    try {
      const history = await this.deps.client.listThreadMessages(threadId, THREAD_SEED_LIMIT);
      for (const item of history) {
        if (item.messageId === excludeMessageId) continue;
        await this.deps.transcriptService.appendMessage(sessionId, {
          externalMessageId: item.messageId,
          role: item.isBot ? 'assistant' : 'user',
          author: item.authorName,
          content: item.content,
          timestamp: item.timestamp,
        });
      }
    } catch (err: unknown) {
      this.onError(err);
    }
  }

  /** The open session this gateway already created for a prewarm window, if any. */
  private async spawnedSession(windowId: string): Promise<Session | undefined> {
    const id = this.windowSessions.get(windowId);
    if (!id) return undefined;
    const session = await this.deps.sessionService.getSession(id).catch(() => undefined);
    return session && session.status !== 'closed' ? session : undefined;
  }

  private async resolveSession(
    windowId: string,
    input: {
      spaceId: string;
      chatId: string;
      threadId: string;
      kind: 'main' | 'thread';
      anchorMessageId: string;
      prewarmMessageId?: string;
    }
  ): Promise<string> {
    const cached = this.windowSessions.get(windowId);
    if (cached) {
      try {
        const session = await this.deps.sessionService.ensureAnchor(cached, input.anchorMessageId);
        if (session.status !== 'closed') return session.id;
      } catch {
        // session vanished; fall through and create a fresh one
      }
    }
    const session = await this.deps.sessionService.getOrCreateByThread({
      ...input,
      channelId: this.deps.channelId,
    });
    return session.id;
  }

  /** Thread windows can predate this process; re-engage them from the store. */
  private async warmThreadWindow(spaceId: string, chatId: string, threadId: string): Promise<void> {
    const windowId = windowIdOf(chatId, threadId, this.deps.channelId);
    if (this.windowSessions.has(windowId)) return;
    const session = await this.deps.sessionService.findByThread(
      spaceId,
      chatId,
      threadId,
      this.deps.channelId
    );
    if (session) this.windowSessions.set(windowId, session.id);
  }

  private async chatSpaceMap(): Promise<Map<string, string>> {
    if (this.deps.channelId && this.deps.channelSpaceId)
      return new Map((this.deps.boundChatIds ?? []).map((id) => [id, this.deps.channelSpaceId!]));
    const spaces = await this.deps.spaces.list();
    const map = new Map<string, string>();
    for (const space of spaces) {
      for (const chatId of space.boundChatIds) map.set(chatId, space.id);
    }
    return map;
  }
}

function isNewCommand(msg: InboundMessage): boolean {
  return msg.text.replace(/@[^\s]+/g, '').trim() === NEW_COMMAND;
}

/** Normalizes a raw Feishu event into an {@link InboundMessage}; null when not actionable. */
export function normalizeMessage(
  event: FeishuMessageEvent,
  botOpenId?: string
): InboundMessage | null {
  const { message } = event;
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') return null;
  const senderOpenId = event.sender?.sender_id?.open_id;
  if (!senderOpenId) return null;
  if (message.chat_type !== 'p2p' && message.chat_type !== 'group') return null;

  const body = readBody(message.message_type, message.content);
  if (!body) return null;
  let text = body.text;
  let named = body.text;

  const mentionedOpenIds: string[] = [];
  for (const mention of message.mentions ?? []) {
    if (mention.key) {
      const readable = mention.name ? `@${mention.name}` : mention.key;
      named = named.split(mention.key).join(readable);
      // The bot's own mention only addresses it; keeping the name would clutter titles and prompts.
      const isBot = botOpenId !== undefined && mention.id?.open_id === botOpenId;
      text = text.split(mention.key).join(isBot ? '' : readable);
    }
    if (mention.id?.open_id) mentionedOpenIds.push(mention.id.open_id);
  }
  // A bare "@bot" keeps its name so the turn still has a prompt.
  text = text.trim() || named.trim();

  return {
    images: body.imageKeys.length
      ? body.imageKeys.map((fileKey) => ({ messageId: message.message_id, fileKey }))
      : undefined,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    threadId: message.thread_id,
    rootId: message.root_id,
    // Feishu stamps every thread message with parent_id = thread root; that is not a user quote.
    parentId:
      message.thread_id && message.parent_id === message.root_id ? undefined : message.parent_id,
    senderOpenId,
    senderName: senderOpenId,
    text,
    mentionedOpenIds,
    unsupportedType: body.unsupported ? message.message_type : undefined,
  };
}

interface MessageBody {
  text: string;
  imageKeys: string[];
  unsupported?: true;
}

/** Reads a message's content by type (wire input); null when a readable type has an invalid body. */
function readBody(type: string, rawContent: string): MessageBody | null {
  if (type !== 'text' && type !== 'image' && type !== 'post') {
    return { text: '', imageKeys: [], unsupported: true };
  }
  let content: unknown;
  try {
    content = JSON.parse(rawContent);
  } catch {
    return null;
  }
  if (!content || typeof content !== 'object') return null;
  if (type === 'post') {
    const post = parsePostContent(content);
    return post.text || post.imageKeys.length ? post : null;
  }
  if (type === 'image') {
    const imageKey = (content as { image_key?: unknown }).image_key;
    return typeof imageKey === 'string' && imageKey
      ? { text: '[Image]', imageKeys: [imageKey] }
      : null;
  }
  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? { text, imageKeys: [] } : null;
}
