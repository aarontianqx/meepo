import type { SpaceMember } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteMembershipRepository } from '../membership-sqlite.js';

function makeMember(overrides: Partial<SpaceMember> = {}): SpaceMember {
  return {
    spaceId: 'space-1',
    userId: 'user-1',
    role: 'owner',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteMembershipRepository', () => {
  let db: Database;
  let repo: SqliteMembershipRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteMembershipRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a membership', async () => {
    await repo.save(makeMember());

    expect(await repo.get('space-1', 'user-1')).toEqual(makeMember());
  });

  it('returns undefined for a missing pair', async () => {
    expect(await repo.get('space-1', 'missing')).toBeUndefined();
  });

  it('overwrites the membership for the same pair', async () => {
    await repo.save(makeMember());
    await repo.save(makeMember({ role: 'manager' }));

    expect((await repo.get('space-1', 'user-1'))?.role).toBe('manager');
    expect(await repo.listBySpace('space-1')).toHaveLength(1);
  });

  it('lists memberships by space', async () => {
    await repo.save(makeMember());
    await repo.save(makeMember({ userId: 'user-2' }));
    await repo.save(makeMember({ spaceId: 'space-2', userId: 'user-3' }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((member) => member.userId).sort()).toEqual(['user-1', 'user-2']);
  });

  it('lists memberships by user', async () => {
    await repo.save(makeMember());
    await repo.save(makeMember({ spaceId: 'space-2' }));
    await repo.save(makeMember({ userId: 'user-2' }));

    const byUser = await repo.listByUser('user-1');
    expect(byUser.map((member) => member.spaceId).sort()).toEqual(['space-1', 'space-2']);
  });
});
