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
  replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean }
  ): Promise<ReplyResult>;
  replyCard(messageId: string, cardId: string, opts?: { replyInThread?: boolean }): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  createCard(cardJson: string): Promise<string>;
  updateCard(cardId: string, cardJson: string, sequence: number, uuid: string): Promise<void>;
  updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void>;
  listThreadMessages(threadId: string, limit?: number): Promise<ThreadHistoryMessage[]>;
}

/** lark.Client adapter for {@link FeishuClient}. */
export class LarkFeishuClient implements FeishuClient {
  constructor(private readonly client: lark.Client) {}

  async replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean }
  ): Promise<ReplyResult> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: 'text',
        reply_in_thread: opts?.replyInThread,
      },
    });
    if (res.code) throw new Error(`im message.reply failed: ${res.code} ${res.msg}`);
    return { messageId: res.data?.message_id ?? '', threadId: res.data?.thread_id };
  }

  async replyCard(
    messageId: string,
    cardId: string,
    opts?: { replyInThread?: boolean }
  ): Promise<void> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        reply_in_thread: opts?.replyInThread,
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
    await this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings, sequence },
    });
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
        timestamp: Number(item.create_time ?? 0) * 1000 || Date.now(),
        isBot,
      });
    }
    return out;
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
