import type { Space } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteSpaceRepository } from '../space-sqlite.js';

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 'space-1',
    name: 'Meepo',
    repoUrl: 'https://example.com/meepo.git',
    defaultBranch: 'main',
    timezone: 'Asia/Shanghai',
    boundChatIds: ['chat-1'],
    requiredTags: ['gpu'],
    longTermMemory: 'remember everything',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('SqliteSpaceRepository', () => {
  let db: Database;
  let repo: SqliteSpaceRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteSpaceRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a space by id', async () => {
    await repo.save(makeSpace());

    const found = await repo.getById('space-1');
    expect(found).toEqual(makeSpace());
  });

  it('round-trips optional fields', async () => {
    const space = makeSpace({
      description: 'desc',
      boundWorkerId: 'worker-1',
    });
    await repo.save(space);

    expect(await repo.getById(space.id)).toEqual(space);
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing space on save', async () => {
    await repo.save(makeSpace());
    await repo.save(makeSpace({ name: 'Renamed', updatedAt: 2000 }));

    const found = await repo.getById('space-1');
    expect(found?.name).toBe('Renamed');
    expect(found?.updatedAt).toBe(2000);
    expect(await repo.list()).toHaveLength(1);
  });

  it('lists all spaces', async () => {
    await repo.save(makeSpace());
    await repo.save(makeSpace({ id: 'space-2', name: 'Other' }));

    const all = await repo.list();
    expect(all).toHaveLength(2);
    expect(all.map((space) => space.id).sort()).toEqual(['space-1', 'space-2']);
  });
});
