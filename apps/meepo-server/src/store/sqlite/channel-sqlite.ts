import type { Database } from 'better-sqlite3';
import type { Channel, ChannelRepository } from '../../domain/channels/channel-service.js';
import type { SecretCodec } from '../../infra/secrets/secret-codec.js';

interface Row {
  id: string;
  data: string;
  app_secret: string;
}
export class SqliteChannelRepository implements ChannelRepository {
  constructor(
    private readonly db: Database,
    private readonly codec: SecretCodec
  ) {}
  private decode(row: Row): Channel {
    return {
      ...(JSON.parse(row.data) as Omit<Channel, 'appSecret'>),
      appSecret: this.codec.decode(row.app_secret),
    };
  }
  list(): Channel[] {
    return (this.db.prepare('SELECT * FROM channels').all() as Row[]).map((r) => this.decode(r));
  }
  get(id: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }
  save(channel: Channel): void {
    const { appSecret, ...data } = channel;
    this.db
      .prepare(
        'INSERT INTO channels (id, app_id, data, app_secret) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, data=excluded.data, app_secret=excluded.app_secret'
      )
      .run(channel.id, channel.appId, JSON.stringify(data), this.codec.encode(appSecret));
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  }
  TxMigrateLegacySessions(channelId: string, spaceId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE sessions SET channel_id = ? WHERE space_id = ? AND channel_id = ''")
        .run(channelId, spaceId);
    })();
  }
}
