import type { Reminder } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteReminderRepository } from '../reminder-sqlite.js';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'reminder-1',
    spaceId: 'space-1',
    objective: 'Check the build',
    requiredTags: [],
    trigger: { kind: 'at', at: 9000 },
    timezone: 'Asia/Shanghai',
    status: 'scheduled',
    createdByUserId: 'user-1',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteReminderRepository', () => {
  let db: Database;
  let repo: SqliteReminderRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteReminderRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a reminder by id', async () => {
    await repo.save(makeReminder());

    expect(await repo.getById('reminder-1')).toEqual(makeReminder());
  });

  it('round-trips optional fields and every trigger kind', async () => {
    const reminders = [
      makeReminder({ id: 'r-delay', trigger: { kind: 'delay', delayMs: 5000 } }),
      makeReminder({ id: 'r-at', trigger: { kind: 'at', at: 9000 } }),
      makeReminder({
        id: 'r-cron',
        trigger: { kind: 'cron', cron: '*/5 * * * *' },
        contextSummary: 'context',
        lastFiredAt: 2000,
      }),
    ];
    for (const reminder of reminders) {
      await repo.save(reminder);
    }

    for (const reminder of reminders) {
      expect(await repo.getById(reminder.id)).toEqual(reminder);
    }
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing reminder on save', async () => {
    await repo.save(makeReminder());
    await repo.save(makeReminder({ status: 'cancelled' }));

    expect((await repo.getById('reminder-1'))?.status).toBe('cancelled');
    expect(await repo.listBySpace('space-1')).toHaveLength(1);
  });

  it('lists only scheduled reminders', async () => {
    await repo.save(makeReminder());
    await repo.save(makeReminder({ id: 'reminder-2', status: 'fired', lastFiredAt: 9000 }));
    await repo.save(makeReminder({ id: 'reminder-3', status: 'cancelled' }));
    await repo.save(makeReminder({ id: 'reminder-4', spaceId: 'space-2' }));

    const scheduled = await repo.listScheduled();
    expect(scheduled.map((reminder) => reminder.id).sort()).toEqual(['reminder-1', 'reminder-4']);
  });

  it('lists reminders by space regardless of status', async () => {
    await repo.save(makeReminder());
    await repo.save(makeReminder({ id: 'reminder-2', status: 'fired', lastFiredAt: 9000 }));
    await repo.save(makeReminder({ id: 'reminder-3', spaceId: 'space-2' }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((reminder) => reminder.id).sort()).toEqual(['reminder-1', 'reminder-2']);
  });
});
