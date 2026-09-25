import type { CronJob } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteCronRepository } from '../cron-sqlite.js';

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    sessionId: 'session-1',
    spaceId: 'space-1',
    cron: '*/5 * * * *',
    prompt: 'check in',
    recurring: true,
    timezone: 'Asia/Shanghai',
    status: 'active',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteCronRepository', () => {
  let db: Database;
  let repo: SqliteCronRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteCronRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a job by id', async () => {
    await repo.save(makeJob());

    expect(await repo.getById('job-1')).toEqual(makeJob());
  });

  it('round-trips optional fields and the recurring flag', async () => {
    const job = makeJob({ recurring: false, lastFiredAt: 2000 });
    await repo.save(job);

    expect(await repo.getById(job.id)).toEqual(job);
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing job on save', async () => {
    await repo.save(makeJob());
    await repo.save(makeJob({ status: 'deleted' }));

    expect((await repo.getById('job-1'))?.status).toBe('deleted');
    expect(await repo.listActive()).toHaveLength(0);
  });

  it('lists only active jobs', async () => {
    await repo.save(makeJob());
    await repo.save(makeJob({ id: 'job-2', status: 'deleted' }));
    await repo.save(makeJob({ id: 'job-3', sessionId: 'session-2' }));

    const active = await repo.listActive();
    expect(active.map((job) => job.id).sort()).toEqual(['job-1', 'job-3']);
  });

  it('lists active jobs for a single session', async () => {
    await repo.save(makeJob());
    await repo.save(makeJob({ id: 'job-2', status: 'deleted' }));
    await repo.save(makeJob({ id: 'job-3', sessionId: 'session-2' }));
    await repo.save(makeJob({ id: 'job-4', recurring: false }));

    const bySession = await repo.listActiveBySession('session-1');
    expect(bySession.map((job) => job.id).sort()).toEqual(['job-1', 'job-4']);
    expect(await repo.listActiveBySession('session-unknown')).toEqual([]);
  });
});
