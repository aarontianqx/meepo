import type { Database } from 'better-sqlite3';
import type { InboundInbox } from '../../domain/im/inbound-inbox.js';
import type { InboundMessage } from '../../domain/im/im-router.js';
export class SqliteInboundInbox implements InboundInbox {
  constructor(private readonly db: Database) {}
  put(channelId: string, message: InboundMessage): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO inbound_inbox(channel_id,message_id,data,received_at) VALUES(?,?,?,?)'
      )
      .run(channelId, message.messageId, JSON.stringify(message), Date.now());
  }
  pending(channelId: string): InboundMessage[] {
    return (
      this.db
        .prepare('SELECT data FROM inbound_inbox WHERE channel_id=? ORDER BY received_at LIMIT 50')
        .all(channelId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as InboundMessage);
  }
  done(channelId: string, messageId: string): void {
    this.db
      .prepare('DELETE FROM inbound_inbox WHERE channel_id=? AND message_id=?')
      .run(channelId, messageId);
  }
}
