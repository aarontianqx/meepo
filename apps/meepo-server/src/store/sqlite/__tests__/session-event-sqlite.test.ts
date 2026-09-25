import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteSessionEventRepository } from '../session-event-sqlite.js';

describe('SqliteSessionEventRepository', () => {
  let db: Database;
  let repo: SqliteSessionEventRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteSessionEventRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('appends events with incrementing seq per session', async () => {
    const first = await repo.append('session-1', 'message', { text: 'hello' }, 1000);
    const second = await repo.append('session-1', 'message', { text: 'world' }, 1001);
    const other = await repo.append('session-2', 'message', { text: 'hi' }, 1002);

    expect(first).toEqual({
      sessionId: 'session-1',
      seq: 1,
      type: 'message',
      payload: { text: 'hello' },
      timestamp: 1000,
    });
    expect(second.seq).toBe(2);
    expect(other.seq).toBe(1);
  });

  it('defaults the timestamp when omitted', async () => {
    const before = Date.now();
    const record = await repo.append('session-1', 'message', null);
    const after = Date.now();

    expect(record.timestamp).toBeGreaterThanOrEqual(before);
    expect(record.timestamp).toBeLessThanOrEqual(after);
  });

  it('lists events for a session ordered by seq', async () => {
    await repo.append('session-1', 'a', 1, 1000);
    await repo.append('session-1', 'b', [2], 1001);
    await repo.append('session-2', 'c', 'other', 1002);
    await repo.append('session-1', 'd', { deep: { value: true } }, 1003);

    const events = await repo.listBySession('session-1');
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual(['a', 'b', 'd']);
    expect(events.map((event) => event.payload)).toEqual([1, [2], { deep: { value: true } }]);
  });

  it('round-trips appended events', async () => {
    await repo.append('session-1', 'message', { text: 'hello' }, 1000);

    const events = await repo.listBySession('session-1');
    expect(events).toEqual([
      {
        sessionId: 'session-1',
        seq: 1,
        type: 'message',
        payload: { text: 'hello' },
        timestamp: 1000,
      },
    ]);
  });

  it('reports the latest seq, defaulting to zero', async () => {
    expect(await repo.latestSeq('session-1')).toBe(0);

    await repo.append('session-1', 'a', null, 1000);
    await repo.append('session-1', 'b', null, 1001);
    await repo.append('session-2', 'c', null, 1002);

    expect(await repo.latestSeq('session-1')).toBe(2);
    expect(await repo.latestSeq('session-2')).toBe(1);
  });
});
