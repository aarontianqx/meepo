/** IM-agnostic inbound message, normalized by the provider transport. */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  /** Present when the message lives inside a thread */
  threadId?: string;
  /** The thread's top-level (root) message id, used as the reply anchor */
  rootId?: string;
  /** Present when the message is a reply to another message */
  parentId?: string;
  senderOpenId: string;
  senderName: string;
  text: string;
  mentionedOpenIds: string[];
}

export type InboundDecision =
  | { action: 'ignore'; reason: string }
  | {
      action: 'dispatch';
      windowId: string;
      /** 'prewarm' means the gateway must spawn the thread first (main-stream mention) */
      threadRef: { kind: 'thread'; threadId: string } | { kind: 'prewarm' };
      sessionKind: 'main' | 'task';
      spaceId: string;
      /** Thread sessions are seeded with existing thread history on creation */
      seedThreadHistory: boolean;
    };

export interface InboundContext {
  botOpenId: string;
  spaceIdForChat(chatId: string): string | undefined;
  /** Fallback space for private chats */
  defaultSpaceId?: string;
  sessionExistsForWindow(windowId: string): boolean;
  seenMessage(messageId: string): boolean;
}

export function windowIdOf(chatId: string, subId: string): string {
  return `feishu:${chatId}:${subId}`;
}

/** Sentinel sub_id of a group's main-stream window (its main session lives here). */
export const GROUP_MAIN_SUB_ID = '_group';

/**
 * The inbound decision chain, in order: dedup -> space resolution ->
 * respond gate -> routing. Pure logic; the gateway supplies the state lookups.
 *
 * Session model:
 * - Private chat: one main session per user, no threads, always answered.
 * - Group thread: the thread's task session (only when engaged or mentioned).
 * - Group main stream: a fresh mention spawns a new thread+task session;
 *   a reply involving the bot continues the group's main session instead.
 */
export function decideInbound(msg: InboundMessage, ctx: InboundContext): InboundDecision {
  if (ctx.seenMessage(msg.messageId)) {
    return { action: 'ignore', reason: 'duplicate message' };
  }

  const spaceId = msg.chatType === 'p2p' ? ctx.defaultSpaceId : ctx.spaceIdForChat(msg.chatId);
  if (!spaceId) {
    return { action: 'ignore', reason: 'chat is not bound to any space' };
  }

  const mentionsBot = msg.mentionedOpenIds.includes(ctx.botOpenId);
  const mentionsOthers = msg.mentionedOpenIds.length > 0 && !mentionsBot;

  if (msg.chatType === 'p2p') {
    return {
      action: 'dispatch',
      windowId: windowIdOf(msg.chatId, msg.senderOpenId),
      threadRef: { kind: 'thread', threadId: msg.senderOpenId },
      sessionKind: 'main',
      spaceId,
      seedThreadHistory: false,
    };
  }

  if (mentionsOthers) {
    return { action: 'ignore', reason: 'mention targets another bot' };
  }

  if (msg.threadId) {
    const windowId = windowIdOf(msg.chatId, msg.threadId);
    const engaged = ctx.sessionExistsForWindow(windowId);
    if (mentionsBot || engaged) {
      return {
        action: 'dispatch',
        windowId,
        threadRef: { kind: 'thread', threadId: msg.threadId },
        sessionKind: 'task',
        spaceId,
        seedThreadHistory: !engaged,
      };
    }
    return { action: 'ignore', reason: 'thread is not engaged' };
  }

  const isReply = msg.rootId !== undefined || msg.parentId !== undefined;
  if (isReply) {
    if (mentionsBot) {
      return {
        action: 'dispatch',
        windowId: windowIdOf(msg.chatId, GROUP_MAIN_SUB_ID),
        threadRef: { kind: 'thread', threadId: GROUP_MAIN_SUB_ID },
        sessionKind: 'main',
        spaceId,
        seedThreadHistory: false,
      };
    }
    return { action: 'ignore', reason: 'main-stream reply without mention' };
  }

  if (mentionsBot) {
    return {
      action: 'dispatch',
      windowId: windowIdOf(msg.chatId, msg.messageId),
      threadRef: { kind: 'prewarm' },
      sessionKind: 'task',
      spaceId,
      seedThreadHistory: false,
    };
  }

  return { action: 'ignore', reason: 'group main-stream message without mention' };
}
