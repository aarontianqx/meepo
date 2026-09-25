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
    message_type: string;
    content: string;
    mentions?: { key: string; name?: string; id?: { open_id?: string } }[];
  };
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
  replyCard(messageId: string, cardId: string): Promise<void>;
  createCard(cardJson: string): Promise<string>;
  updateCardContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid: string
  ): Promise<void>;
  updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void>;
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

  async replyCard(messageId: string, cardId: string): Promise<void> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        reply_in_thread: true,
      },
    });
    if (res.code) throw new Error(`im message.reply (card) failed: ${res.code} ${res.msg}`);
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

  async updateCardContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid: string
  ): Promise<void> {
    await this.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence, uuid },
    });
  }

  async updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void> {
    await this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings, sequence },
    });
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
  onEvent: (event: FeishuMessageEvent) => Promise<void>
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
  });
  wsClient.start({ eventDispatcher });
  return wsClient;
}
