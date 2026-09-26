import type { DispatchService } from '../../domain/dispatch/dispatch-service.js';
import {
  decideInbound,
  GROUP_MAIN_SUB_ID,
  windowIdOf,
  type InboundDecision,
  type InboundMessage,
} from '../../domain/im/im-router.js';
import type { SessionService } from '../../domain/sessions/session-service.js';
import type { TranscriptService } from '../../domain/sessions/transcript-service.js';
import type { SpaceRepository } from '../../domain/spaces/space-repository.js';
import { DedupCache } from './dedup-cache.js';
import type { FeishuClient, FeishuMessageEvent } from './feishu-client.js';

const MESSAGE_DEDUP_TTL_MS = 30 * 60 * 1000;
const PREWARM_TEXT = '正在处理，请稍候…';
const NEW_COMMAND = '/new';
const THREAD_SEED_LIMIT = 50;

export interface FeishuGatewayDeps {
  client: FeishuClient;
  sessionService: SessionService;
  dispatchService: DispatchService;
  transcriptService: TranscriptService;
  spaces: SpaceRepository;
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
  private readonly onError: (err: unknown) => void;

  constructor(private readonly deps: FeishuGatewayDeps) {
    this.dedup = deps.dedup ?? new DedupCache(MESSAGE_DEDUP_TTL_MS);
    this.onError = deps.onError ?? (() => undefined);
  }

  /** Entry point for the raw WS event. Never throws. */
  async handleEvent(event: FeishuMessageEvent): Promise<void> {
    try {
      const msg = normalizeMessage(event);
      if (!msg) return;
      await this.handleInbound(msg);
    } catch (err: unknown) {
      this.onError(err);
    }
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (this.dedup.has(msg.messageId)) return;

    const spaceByChat = await this.chatSpaceMap();
    const spaceId = msg.chatType === 'p2p' ? this.deps.defaultSpaceId : spaceByChat.get(msg.chatId);
    if (spaceId && msg.threadId) await this.warmThreadWindow(spaceId, msg.chatId, msg.threadId);

    if (msg.text === NEW_COMMAND) {
      this.dedup.add(msg.messageId);
      await this.handleNewCommand(msg);
      return;
    }

    const decision = decideInbound(msg, {
      botOpenId: this.deps.botOpenId,
      defaultSpaceId: this.deps.defaultSpaceId,
      spaceIdForChat: (chatId) => spaceByChat.get(chatId),
      sessionExistsForWindow: (windowId) => this.windowSessions.has(windowId),
      seenMessage: (messageId) => this.dedup.seen(messageId),
    });
    if (decision.action === 'ignore') return;
    await this.executeDispatch(msg, decision);
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
        ? windowIdOf(msg.chatId, msg.senderOpenId)
        : windowIdOf(msg.chatId, GROUP_MAIN_SUB_ID);
    const sessionId = this.windowSessions.get(windowId);
    if (!sessionId) {
      await this.deps.client.replyText(msg.messageId, '当前窗口没有进行中的会话。');
      return;
    }
    await this.deps.sessionService.close(sessionId);
    for (const [key, value] of this.windowSessions) {
      if (value === sessionId) this.windowSessions.delete(key);
    }
    await this.deps.client.replyText(msg.messageId, '已关闭当前会话，下一条消息将开启新会话。');
  }

  private async executeDispatch(
    msg: InboundMessage,
    decision: Extract<InboundDecision, { action: 'dispatch' }>
  ): Promise<void> {
    let threadId: string;
    let anchorMessageId: string;
    if (decision.threadRef.kind === 'prewarm') {
      const reply = await this.deps.client.replyText(msg.messageId, PREWARM_TEXT, {
        replyInThread: true,
      });
      threadId = reply.threadId ?? msg.messageId;
      anchorMessageId = msg.messageId;
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
    });
    this.windowSessions.set(decision.windowId, sessionId);
    this.windowSessions.set(windowIdOf(msg.chatId, threadId), sessionId);

    if (decision.seedThreadHistory) {
      await this.seedThreadHistory(sessionId, threadId, msg.messageId);
    }

    await this.deps.dispatchService.dispatchSessionTurn({
      sessionId,
      prompt: msg.text,
      source: { kind: 'user_message', messageId: msg.messageId },
      delivery: 'wait',
      author: msg.senderName,
    });
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

  private async resolveSession(
    windowId: string,
    input: {
      spaceId: string;
      chatId: string;
      threadId: string;
      kind: 'main' | 'thread';
      anchorMessageId: string;
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
    const session = await this.deps.sessionService.getOrCreateByThread(input);
    return session.id;
  }

  /** Thread windows can predate this process; re-engage them from the store. */
  private async warmThreadWindow(spaceId: string, chatId: string, threadId: string): Promise<void> {
    const windowId = windowIdOf(chatId, threadId);
    if (this.windowSessions.has(windowId)) return;
    const session = await this.deps.sessionService.findByThread(spaceId, chatId, threadId);
    if (session) this.windowSessions.set(windowId, session.id);
  }

  private async chatSpaceMap(): Promise<Map<string, string>> {
    const spaces = await this.deps.spaces.list();
    const map = new Map<string, string>();
    for (const space of spaces) {
      for (const chatId of space.boundChatIds) map.set(chatId, space.id);
    }
    return map;
  }
}

/** Normalizes a raw Feishu event into an {@link InboundMessage}; null when not actionable. */
export function normalizeMessage(event: FeishuMessageEvent): InboundMessage | null {
  const { message } = event;
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') return null;
  const senderOpenId = event.sender?.sender_id?.open_id;
  if (!senderOpenId) return null;
  if (message.chat_type !== 'p2p' && message.chat_type !== 'group') return null;
  if (message.message_type !== 'text') return null;

  let text: string;
  try {
    const content: unknown = JSON.parse(message.content);
    text = (content as { text?: unknown }).text as string;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;

  const mentionedOpenIds: string[] = [];
  for (const mention of message.mentions ?? []) {
    if (mention.key) text = text.split(mention.key).join('');
    if (mention.id?.open_id) mentionedOpenIds.push(mention.id.open_id);
  }

  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    threadId: message.thread_id,
    rootId: message.root_id,
    parentId: message.parent_id,
    senderOpenId,
    senderName: senderOpenId,
    text: text.trim(),
    mentionedOpenIds,
  };
}
