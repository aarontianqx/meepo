import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../config.js';

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
}

/** lark.Client adapter for {@link FeishuClient}. */
export class LarkFeishuClient implements FeishuClient {
  private readonly chatNames = new Map<string, string>();

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
      let content: string;
      try {
        const body = JSON.parse(item.body?.content ?? '{}') as { text?: string };
        content = body.text ?? '';
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const isBot = item.sender?.sender_type === 'app';
      out.push({
        messageId: item.message_id ?? '',
        authorName: item.sender?.sender_name ?? item.sender?.id ?? 'unknown',
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
    if (!item || item.msg_type !== 'text') return undefined;
    try {
      const content = JSON.parse(item.body?.content ?? '{}') as { text?: string };
      return {
        sender: item.sender?.sender_name ?? item.sender?.id ?? 'unknown',
        text: content.text ?? '',
        chatId: item.chat_id ?? '',
      };
    } catch {
      return undefined;
    }
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
