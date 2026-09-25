import type { Session } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteSessionRepository } from '../session-sqlite.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    spaceId: 'space-1',
    kind: 'main',
    chatId: 'chat-1',
    threadId: 'thread-1',
    status: 'active',
    createdAt: 1000,
    lastActiveAt: 1000,
    ...overrides,
  };
}

describe('SqliteSessionRepository', () => {
  let db: Database;
  let repo: SqliteSessionRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteSessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a session by id', async () => {
    await repo.save(makeSession({ boundWorkerId: 'worker-1' }));

    expect(await repo.getById('session-1')).toEqual(makeSession({ boundWorkerId: 'worker-1' }));
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('finds a session by thread coordinates', async () => {
    await repo.save(makeSession());
    await repo.save(makeSession({ id: 'session-2', threadId: 'thread-2', kind: 'task' }));

    expect(await repo.getByThread('space-1', 'chat-1', 'thread-1')).toEqual(makeSession());
    expect(await repo.getByThread('space-1', 'chat-1', 'thread-unknown')).toBeUndefined();
    expect(await repo.getByThread('space-2', 'chat-1', 'thread-1')).toBeUndefined();
  });

  it('overwrites an existing session on save', async () => {
    await repo.save(makeSession());
    await repo.save(makeSession({ status: 'closed', lastActiveAt: 2000 }));

    const found = await repo.getById('session-1');
    expect(found?.status).toBe('closed');
    expect(await repo.listBySpace('space-1')).toHaveLength(1);
  });

  it('lists sessions by space', async () => {
    await repo.save(makeSession());
    await repo.save(makeSession({ id: 'session-2', threadId: 'thread-2' }));
    await repo.save(makeSession({ id: 'session-3', spaceId: 'space-2' }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((session) => session.id).sort()).toEqual(['session-1', 'session-2']);
  });
});
