import type { Schedule } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteScheduleRepository } from '../schedule-sqlite.js';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    spaceId: 'space-1',
    timing: { kind: 'cron', expression: '*/5 * * * *', timezone: 'Asia/Shanghai' },
    action: { kind: 'resume_session', sessionId: 'session-1', prompt: 'check in' },
    status: 'active',
    createdByUserId: 'user-1',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteScheduleRepository', () => {
  let db: Database;
  let repo: SqliteScheduleRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteScheduleRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a schedule by id', async () => {
    await repo.save(makeSchedule());

    expect(await repo.getById('schedule-1')).toEqual(makeSchedule());
  });

  it('round-trips every timing and action kind', async () => {
    const schedules = [
      makeSchedule({
        id: 'sc-at',
        timing: { kind: 'at', at: 9000 },
        action: {
          kind: 'create_ticket',
          objective: 'audit',
          contextSummary: 'context',
          requiredTags: ['gpu'],
          originSessionId: 'session-9',
        },
      }),
      makeSchedule({ id: 'sc-cron', lastFiredAt: 2000, status: 'done' }),
    ];
    for (const schedule of schedules) {
      await repo.save(schedule);
    }

    for (const schedule of schedules) {
      expect(await repo.getById(schedule.id)).toEqual(schedule);
    }
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing schedule on save', async () => {
    await repo.save(makeSchedule());
    await repo.save(makeSchedule({ status: 'deleted' }));

    expect((await repo.getById('schedule-1'))?.status).toBe('deleted');
    expect(await repo.listActive()).toHaveLength(0);
  });

  it('lists only active schedules', async () => {
    await repo.save(makeSchedule());
    await repo.save(makeSchedule({ id: 'schedule-2', status: 'done' }));
    await repo.save(makeSchedule({ id: 'schedule-3', status: 'deleted' }));

    const active = await repo.listActive();
    expect(active.map((schedule) => schedule.id)).toEqual(['schedule-1']);
  });

  it('lists schedules by space regardless of status', async () => {
    await repo.save(makeSchedule());
    await repo.save(makeSchedule({ id: 'schedule-2', status: 'done' }));
    await repo.save(makeSchedule({ id: 'schedule-3', spaceId: 'space-2' }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((schedule) => schedule.id).sort()).toEqual(['schedule-1', 'schedule-2']);
    expect(await repo.list()).toHaveLength(3);
  });
});
