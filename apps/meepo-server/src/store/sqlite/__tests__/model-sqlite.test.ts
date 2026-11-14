import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelRegistry } from '../../../domain/models/model-registry.js';
import { SecretCodec } from '../../../infra/secrets/secret-codec.js';
import { openDatabase } from '../database.js';
import { SqliteModelRepository, SqliteModelUsage } from '../model-sqlite.js';
import { SqliteSpaceRepository } from '../space-sqlite.js';

describe('SqliteModelRepository', () => {
  let db: Database;
  let codec: SecretCodec;
  let repo: SqliteModelRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    codec = new SecretCodec('0'.repeat(64));
    repo = new SqliteModelRepository(db, codec);
  });
  afterEach(() => db.close());

  it('round-trips the registry through the encrypted settings row', () => {
    const registry: ModelRegistry = {
      providers: [{ id: 'p', name: 'P', kind: 'openai', baseUrl: 'https://x.test', apiKey: 'k' }],
      entries: [
        {
          id: 'm',
          providerId: 'p',
          model: 'gpt',
          contextWindow: 128_000,
          maxTokens: 16_384,
          reasoningEfforts: [],
          imageInput: false,
        },
      ],
      defaultModelId: 'm',
    };
    repo.save(registry);
    expect(repo.load()).toEqual(registry);
  });

  it.each([
    ['the flat pre-provider shape', { entries: [{ id: 'k3', model: 'kimi-k3' }] }],
    [
      'entries without capability fields',
      { providers: [], entries: [{ id: 'm', providerId: 'p', model: 'm' }] },
    ],
  ])('refuses to load %s with the fix in the message', (_name, blob) => {
    db.prepare("INSERT INTO server_settings(key,value) VALUES('models',?)").run(
      codec.encode(JSON.stringify(blob))
    );
    expect(() => repo.load()).toThrow(/outdated format.*Delete the 'models' row/s);
  });

  it('counts only spaces that explicitly select the model', async () => {
    const spaces = new SqliteSpaceRepository(db);
    const base = {
      name: 'S',
      repoUrl: 'https://example.com/r.git',
      defaultBranch: 'main',
      timezone: 'UTC',
      boundChatIds: [],
      requiredTags: [],
      longTermMemory: '',
      createdAt: 1,
      updatedAt: 1,
    };
    await spaces.save({ ...base, id: 's1', model: { modelId: 'm' } });
    await spaces.save({ ...base, id: 's2', model: { modelId: 'm', thinkingLevel: 'high' } });
    await spaces.save({ ...base, id: 's3' });
    const usage = new SqliteModelUsage(db);
    expect(await usage.countSpacesUsing('m')).toBe(2);
    expect(await usage.countSpacesUsing('other')).toBe(0);
  });
});
