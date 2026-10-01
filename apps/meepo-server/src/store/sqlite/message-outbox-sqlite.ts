import type { Database } from 'better-sqlite3';
import type { MessageOutbox, PendingReply } from '../../domain/outbound/message-outbox.js';
export class SqliteMessageOutbox implements MessageOutbox {
  constructor(private readonly db: Database) {}
  pending(channelId: string): PendingReply[] {
    return (
      this.db
        .prepare('SELECT * FROM message_outbox WHERE channel_id=? AND sent=0')
        .all(channelId) as {
        id: string;
        channel_id: string;
        message_id: string;
        text: string;
        created_at: number;
      }[]
    ).map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      messageId: r.message_id,
      text: r.text,
      createdAt: r.created_at,
    }));
  }
  sent(id: string): void {
    this.db.prepare('UPDATE message_outbox SET sent=1 WHERE id=?').run(id);
  }
}
