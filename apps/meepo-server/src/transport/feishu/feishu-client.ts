import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../config.js';
import { parsePostContent } from './post-content.js';

const USER_NAME_TTL_MS = 60 * 60 * 1000;
const USER_NAME_MISS_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_MESSAGE_PAGES = 20;

export interface ReplyResult {
  messageId: string;
  threadId?: string;
}

/** Raw `im.message.receive_v1` event, reduced to the fields the gateway reads. */
export interface FeishuMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    thread_id?: string;
    root_id?: string;
    parent_id?: string;
    message_type: string;
    content: string;
    mentions?: { key: string; name?: string; id?: { open_id?: string } }[];
  };
}

/** A message in a thread's history, reduced for transcript seeding. */
export interface ThreadHistoryMessage {
  messageId: string;
  authorName: string;
  content: string;
  timestamp: number;
  isBot: boolean;
}

/** Raw `card.action.trigger` event, reduced to the fields the handler reads. */
export interface FeishuCardActionEvent {
  operator?: { open_id?: string };
  action?: { tag?: string; value?: Record<string, string> };
}

/**
 * Narrow port over the Feishu OpenAPI surface used by the gateway and the
 * card streamer. Implemented by the lark SDK adapter; faked in tests.
 */
export interface FeishuClient {
  findReply?(input: {
    chatId: string;
    threadId?: string;
    parentId: string;
    since: number;
    cardId?: string;
    text?: string;
  }): Promise<ReplyResult | undefined>;
  replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean; uuid?: string }
  ): Promise<ReplyResult>;
  replyCard(
    messageId: string,
    cardId: string,
    opts?: { replyInThread?: boolean; uuid?: string }
  ): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  createCard(cardJson: string): Promise<string>;
  updateCard(cardId: string, cardJson: string, sequence: number, uuid: string): Promise<void>;
  updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void>;
  listThreadMessages(threadId: string, limit?: number): Promise<ThreadHistoryMessage[]>;
  getChatName(chatId: string): Promise<string>;
  getMessage?(
    messageId: string
  ): Promise<{ sender: string; text: string; chatId: string } | undefined>;
  /** Group messages created since `since` (epoch ms), oldest first, shaped like live events. */
  listRecentMessages?(chatId: string, since: number): Promise<FeishuMessageEvent[]>;
  /** Display name of a user by open_id; the open_id itself when it cannot be resolved. */
  getUserName?(openId: string): Promise<string>;
}

/** lark.Client adapter for {@link FeishuClient}. */
export class LarkFeishuClient implements FeishuClient {
  private readonly chatNames = new Map<string, string>();
  private readonly userNames = new Map<string, { name: string; expiresAt: number }>();

  constructor(private readonly client: lark.Client) {}

  async findReply(input: {
    chatId: string;
    threadId?: string;
    parentId: string;
    since: number;
    cardId?: string;
    text?: string;
  }): Promise<ReplyResult | undefined> {
    let pageToken: string | undefined;
    do {
      const response = await this.client.im.v1.message.list({
        params: {
          container_id_type: input.threadId ? 'thread' : 'chat',
          container_id: input.threadId ?? input.chatId,
          start_time: String(Math.floor(input.since / 1000) - 60),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          page_token: pageToken,
        },
      });
      if (response.code)
        throw new Error(`Outbound reconciliation failed: ${response.code} ${response.msg}`);
      for (const message of response.data?.items ?? []) {
        if (
          message.sender?.sender_type !== 'app' ||
          message.sender.id !== this.client.appId ||
          message.deleted
        )
          continue;
        if (input.cardId && message.msg_type === 'interactive' && message.message_id) {
          const converted = await this.client.cardkit.v1.card.idConvert({
            data: { message_id: message.message_id },
          });
          if (converted.code)
            throw new Error(`Card reconciliation failed: ${converted.code} ${converted.msg}`);
          if (converted.data?.card_id === input.cardId)
            return { messageId: message.message_id, threadId: message.thread_id };
        }
        if (
          input.text !== undefined &&
          message.msg_type === 'text' &&
          message.parent_id === input.parentId
        ) {
          const body = JSON.parse(message.body?.content ?? '{}') as { text?: string };
          if (body.text === input.text)
            return { messageId: message.message_id ?? '', threadId: message.thread_id };
        }
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return undefined;
  }

  async replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean; uuid?: string }
  ): Promise<ReplyResult> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: 'text',
        reply_in_thread: opts?.replyInThread,
        uuid: opts?.uuid,
      },
    });
    if (res.code) throw new Error(`im message.reply failed: ${res.code} ${res.msg}`);
    return { messageId: res.data?.message_id ?? '', threadId: res.data?.thread_id };
  }

  async replyCard(
    messageId: string,
    cardId: string,
    opts?: { replyInThread?: boolean; uuid?: string }
  ): Promise<void> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        reply_in_thread: opts?.replyInThread,
        uuid: opts?.uuid,
      },
    });
    if (res.code) throw new Error(`im message.reply (card) failed: ${res.code} ${res.msg}`);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const res = await this.client.im.v1.message.delete({ path: { message_id: messageId } });
    if (res.code) throw new Error(`im message.delete failed: ${res.code} ${res.msg}`);
  }

  async createCard(cardJson: string): Promise<string> {
    const res = await this.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: cardJson },
    });
    if (res.code || !res.data?.card_id) {
      throw new Error(`cardkit card.create failed: ${res.code} ${res.msg}`);
    }
    return res.data.card_id;
  }

  async updateCard(
    cardId: string,
    cardJson: string,
    sequence: number,
    uuid: string
  ): Promise<void> {
    const res = await this.client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: 'card_json', data: cardJson }, sequence, uuid },
    });
    if (res.code) throw new Error(`cardkit card.update failed: ${res.code} ${res.msg}`);
  }

  async updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void> {
    const res = await this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings, sequence },
    });
    if (res.code) throw new Error(`cardkit settings failed: ${res.code} ${res.msg}`);
  }

  async listThreadMessages(threadId: string, limit = 50): Promise<ThreadHistoryMessage[]> {
    const res = await this.client.im.v1.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: Math.min(limit, 50),
        sort_type: 'ByCreateTimeAsc',
      },
    });
    if (res.code) throw new Error(`im message.list failed: ${res.code} ${res.msg}`);
    const items = res.data?.items ?? [];
    const out: ThreadHistoryMessage[] = [];
    for (const item of items.slice(-limit)) {
      const content = messageText(item);
      if (!content.trim()) continue;
      const isBot = item.sender?.sender_type === 'app';
      const senderId = item.sender?.id;
      out.push({
        messageId: item.message_id ?? '',
        authorName: senderId && !isBot ? await this.getUserName(senderId) : (senderId ?? 'unknown'),
        content: content.trim(),
        timestamp: Number(item.create_time ?? 0) || Date.now(),
        isBot,
      });
    }
    return out;
  }

  async getMessage(
    messageId: string
  ): Promise<{ sender: string; text: string; chatId: string } | undefined> {
    const res = await this.client.im.v1.message.get({ path: { message_id: messageId } });
    if (res.code) return undefined;
    const item = res.data?.items?.[0];
    if (!item || (item.msg_type !== 'text' && item.msg_type !== 'post')) return undefined;
    const senderId = item.sender?.id;
    return {
      sender:
        senderId && item.sender?.sender_type !== 'app'
          ? await this.getUserName(senderId)
          : (senderId ?? 'unknown'),
      text: messageText(item),
      chatId: item.chat_id ?? '',
    };
  }

  async listRecentMessages(chatId: string, since: number): Promise<FeishuMessageEvent[]> {
    const events: FeishuMessageEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_RECENT_MESSAGE_PAGES; page++) {
      const res = await this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(Math.floor(since / 1000)),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          page_token: pageToken,
        },
      });
      if (res.code) throw new Error(`im message.list failed: ${res.code} ${res.msg}`);
      for (const item of res.data?.items ?? []) {
        if (item.deleted || !item.message_id || !item.msg_type || !item.sender?.id) continue;
        events.push({
          sender: { sender_id: { open_id: item.sender.id }, sender_type: item.sender.sender_type },
          message: {
            message_id: item.message_id,
            chat_id: chatId,
            chat_type: 'group',
            thread_id: item.thread_id,
            root_id: item.root_id,
            parent_id: item.parent_id,
            message_type: item.msg_type,
            content: item.body?.content ?? '',
            mentions: item.mentions?.map((m) => ({
              key: m.key,
              name: m.name,
              id: { open_id: m.id },
            })),
          },
        });
      }
      if (!res.data?.has_more) break;
      pageToken = res.data.page_token;
    }
    return events;
  }

  /** Resolves a user's display name (needs the contact read scope); caches misses briefly. */
  async getUserName(openId: string): Promise<string> {
    const cached = this.userNames.get(openId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    let name: string | undefined;
    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      name = res.data?.user?.name || undefined;
    } catch {
      // Missing scope or user outside the app's visibility: keep the open_id.
    }
    this.userNames.set(openId, {
      name: name ?? openId,
      expiresAt: Date.now() + (name ? USER_NAME_TTL_MS : USER_NAME_MISS_TTL_MS),
    });
    return name ?? openId;
  }

  /** Resolves a chat's display name with a small in-process cache (falls back to the id). */
  async getChatName(chatId: string): Promise<string> {
    const cached = this.chatNames.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const name = res.data?.name || chatId;
      this.chatNames.set(chatId, name);
      return name;
    } catch {
      return chatId;
    }
  }
}

export function createLarkClient(config: FeishuConfig): lark.Client {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
}

/** Fetches and caches the bot's own open_id (used to detect @mentions of the bot). */
export async function fetchBotOpenId(client: lark.Client): Promise<string> {
  const res = await client.request<{
    bot?: { open_id?: string };
    data?: { bot?: { open_id?: string } };
  }>({
    method: 'GET',
    url: '/open-apis/bot/v3/info',
  });
  const openId = res?.bot?.open_id ?? res?.data?.bot?.open_id;
  if (!openId) throw new Error('bot/v3/info returned no open_id');
  return openId;
}

/** Starts the WS long connection; events are forwarded to `onEvent`. */
export function startFeishuWs(
  config: FeishuConfig,
  onEvent: (event: FeishuMessageEvent) => Promise<void>,
  onCardAction?: (event: FeishuCardActionEvent) => Promise<void>
): lark.WSClient {
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.info,
  });
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      await onEvent(data as FeishuMessageEvent);
    },
    'card.action.trigger': async (data: unknown) => {
      await onCardAction?.(data as FeishuCardActionEvent);
    },
  });
  wsClient.start({ eventDispatcher });
  return wsClient;
}

export interface ReadableItem {
  msg_type?: string;
  body?: { content?: string };
  mentions?: { key: string; name: string }[];
}

/** Plain text of a fetched `text` or `post` message with mention keys replaced by names; '' for anything else. */
export function messageText(item: ReadableItem): string {
  let content: { text?: string };
  try {
    content = JSON.parse(item.body?.content ?? '{}') as { text?: string };
  } catch {
    return '';
  }
  let text =
    item.msg_type === 'post'
      ? parsePostContent(content).text
      : item.msg_type === 'text'
        ? (content.text ?? '')
        : '';
  for (const mention of item.mentions ?? []) {
    text = text.split(mention.key).join(mention.name ? `@${mention.name}` : mention.key);
  }
  return text;
}
