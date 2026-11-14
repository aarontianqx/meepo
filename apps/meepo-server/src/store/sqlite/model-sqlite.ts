import type { Database } from 'better-sqlite3';
import type { ModelRegistry } from '../../domain/models/model-registry.js';
import type { ModelRepository, ModelUsage } from '../../domain/models/model-service.js';
import type { SecretCodec } from '../../infra/secrets/secret-codec.js';

export class SqliteModelRepository implements ModelRepository {
  constructor(
    private readonly db: Database,
    private readonly codec: SecretCodec
  ) {}

  load(): ModelRegistry | undefined {
    const row = this.db.prepare("SELECT value FROM server_settings WHERE key='models'").get() as
      { value: string } | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(this.codec.decode(row.value)) as ModelRegistry;
    assertCurrentShape(stored);
    return stored;
  }

  save(registry: ModelRegistry): void {
    this.db
      .prepare(
        "INSERT INTO server_settings(key,value) VALUES('models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(this.codec.encode(JSON.stringify(registry)));
  }
}

/**
 * A registry stored by an older build lacks providers or capability fields. Models are not
 * migrated, so fail at startup with the fix instead of a TypeError on the first request.
 */
function assertCurrentShape(stored: ModelRegistry): void {
  const current =
    Array.isArray(stored.providers) &&
    Array.isArray(stored.entries) &&
    stored.entries.every(
      (e) =>
        Number.isInteger(e.contextWindow) &&
        Number.isInteger(e.maxTokens) &&
        Array.isArray(e.reasoningEfforts) &&
        typeof e.imageInput === 'boolean'
    );
  if (!current)
    throw new Error(
      "The stored model registry is in an outdated format. Delete the 'models' row from the " +
        'server_settings table and restart; it is re-seeded from MEEPO_MODELS when that is set.'
    );
}

/** Counts Spaces that explicitly select a model (a null `model_id` follows the registry default). */
export class SqliteModelUsage implements ModelUsage {
  constructor(private readonly db: Database) {}

  async countSpacesUsing(modelId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM spaces WHERE model_id = ?')
      .get(modelId) as { n: number };
    return row.n;
  }
}
