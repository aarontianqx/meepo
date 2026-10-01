import type { Database } from 'better-sqlite3';
import type { WebhookTokenRepository } from '../../domain/webhooks/webhook-service.js';
export class SqliteWebhookTokenRepository implements WebhookTokenRepository {
  constructor(private readonly db: Database) {}
  get(spaceId: string): string | undefined {
    return (
      this.db.prepare('SELECT hash FROM webhook_tokens WHERE space_id=?').get(spaceId) as
        { hash: string } | undefined
    )?.hash;
  }
  save(spaceId: string, hash: string): void {
    this.db
      .prepare(
        'INSERT INTO webhook_tokens(space_id,hash) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET hash=excluded.hash'
      )
      .run(spaceId, hash);
  }
  delete(spaceId: string): void {
    this.db.prepare('DELETE FROM webhook_tokens WHERE space_id=?').run(spaceId);
  }
}
