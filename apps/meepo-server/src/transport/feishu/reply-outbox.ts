import { createHash } from 'node:crypto';
import type { MessageOutbox } from '../../domain/outbound/message-outbox.js';
import type { FeishuClient } from './feishu-client.js';
export class ReplyOutbox {
  private flushing = false;
  constructor(
    private readonly channelId: string,
    private readonly repo: MessageOutbox,
    private readonly client: FeishuClient
  ) {}
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const p of this.repo.pending(this.channelId)) {
        const parent = await this.client.getMessage?.(p.messageId);
        const sent =
          parent &&
          (await this.client.findReply?.({
            chatId: parent.chatId,
            parentId: p.messageId,
            since: p.createdAt,
            text: p.text,
          }));
        if (!sent)
          await this.client.replyText(p.messageId, p.text, {
            uuid: createHash('sha256').update(p.id).digest('hex').slice(0, 40),
          });
        this.repo.sent(p.id);
      }
    } finally {
      this.flushing = false;
    }
  }
}
