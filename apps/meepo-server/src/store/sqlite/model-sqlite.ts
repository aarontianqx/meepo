import type { Database } from 'better-sqlite3';
import type { ModelRepository } from '../../domain/models/model-service.js';
import type { ModelRegistry } from '../../domain/models/model-registry.js';
import type { SecretCodec } from '../../infra/secrets/secret-codec.js';
export class SqliteModelRepository implements ModelRepository {
  constructor(
    private readonly db: Database,
    private readonly codec: SecretCodec
  ) {}
  load(): ModelRegistry | undefined {
    const row = this.db.prepare("SELECT value FROM server_settings WHERE key='models'").get() as
      { value: string } | undefined;
    return row ? (JSON.parse(this.codec.decode(row.value)) as ModelRegistry) : undefined;
  }
  save(registry: ModelRegistry): void {
    this.db
      .prepare(
        "INSERT INTO server_settings(key,value) VALUES('models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(this.codec.encode(JSON.stringify(registry)));
  }
}
