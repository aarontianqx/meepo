/** IM-agnostic inbound message, normalized by the provider transport. */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  /** Present when the message lives inside a thread */
  threadId?: string;
  senderOpenId: string;
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

/**
 * The inbound decision chain, in order: dedup -> space resolution ->
 * respond gate -> routing. Pure logic; the gateway supplies the state lookups.
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
      threadRef: { kind: 'thread', threadId: msg.threadId ?? msg.messageId },
      sessionKind: 'main',
      spaceId,
    };
  }

  if (mentionsOthers) {
    return { action: 'ignore', reason: 'mention targets another bot' };
  }

  if (msg.threadId) {
    const windowId = windowIdOf(msg.chatId, msg.threadId);
    if (mentionsBot || ctx.sessionExistsForWindow(windowId)) {
      return {
        action: 'dispatch',
        windowId,
        threadRef: { kind: 'thread', threadId: msg.threadId },
        sessionKind: 'task',
        spaceId,
      };
    }
    return { action: 'ignore', reason: 'thread is not engaged' };
  }

  if (mentionsBot) {
    return {
      action: 'dispatch',
      windowId: windowIdOf(msg.chatId, msg.messageId),
      threadRef: { kind: 'prewarm' },
      sessionKind: 'task',
      spaceId,
    };
  }

  return { action: 'ignore', reason: 'group main-stream message without mention' };
}
