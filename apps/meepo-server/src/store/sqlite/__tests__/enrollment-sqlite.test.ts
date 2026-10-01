import type { WorkerEnrollmentToken } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteEnrollmentTokenRepository } from '../enrollment-sqlite.js';

function makeToken(overrides: Partial<WorkerEnrollmentToken> = {}): WorkerEnrollmentToken {
  return {
    id: 'token-1',
    spaceIds: ['space-1'],
    issuedByUserId: 'user-1',
    token: 'secret-1',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteEnrollmentTokenRepository', () => {
  let db: Database;
  let repo: SqliteEnrollmentTokenRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteEnrollmentTokenRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a token by its secret value', async () => {
    await repo.save(makeToken());

    const saved = await repo.getByToken('secret-1');
    expect(saved).toMatchObject({ ...makeToken(), token: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(db.prepare('SELECT * FROM enrollment_tokens').all())).not.toContain(
      'secret-1'
    );
  });

  it('round-trips optional fields', async () => {
    const token = makeToken({
      label: 'gpu node',
      expiresAt: 9000,
      lastUsedAt: 2000,
    });
    await repo.save(token);

    expect(await repo.getByToken(token.token)).toMatchObject({
      ...token,
      token: expect.stringMatching(/^sha256:/),
    });
  });

  it('returns undefined for an unknown secret', async () => {
    expect(await repo.getByToken('missing')).toBeUndefined();
  });

  it('overwrites an existing token on save', async () => {
    await repo.save(makeToken());
    await repo.save(makeToken({ lastUsedAt: 3000 }));

    expect((await repo.getByToken('secret-1'))?.lastUsedAt).toBe(3000);
    expect(await repo.listBySpace('space-1')).toHaveLength(1);
  });

  it('lists tokens by space', async () => {
    await repo.save(makeToken());
    await repo.save(
      makeToken({ id: 'token-2', token: 'secret-2', spaceIds: ['space-1', 'space-2'] })
    );
    await repo.save(makeToken({ id: 'token-3', token: 'secret-3', spaceIds: ['space-2'] }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((token) => token.id).sort()).toEqual(['token-1', 'token-2']);
    expect(await repo.listBySpace('space-unknown')).toEqual([]);
  });
  it('binds token and worker identity in both directions, even after revocation', async () => {
    await repo.save(makeToken());
    await repo.save(makeToken({ id: 'token-2', token: 'secret-2', spaceIds: ['other'] }));
    expect(await repo.bindWorker('token-1', 'worker')).toBe(true);
    expect(await repo.bindWorker('token-1', 'other-worker')).toBe(false);
    expect(await repo.bindWorker('token-2', 'worker')).toBe(false);
    const first = await repo.getById('token-1');
    await repo.save({ ...first!, revokedAt: 3000 });
    expect(await repo.bindWorker('token-2', 'worker')).toBe(false);
  });
});
