import type { Run } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteRunRepository } from '../run-sqlite.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    work: { kind: 'ticket', ticketId: 'ticket-1' },
    attempt: 1,
    status: 'dispatched',
    createdAt: 1000,
    ...overrides,
  };
}

describe('SqliteRunRepository', () => {
  let db: Database;
  let repo: SqliteRunRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a run by id', async () => {
    await repo.save(makeRun());

    expect(await repo.getById('run-1')).toEqual(makeRun());
  });

  it('round-trips optional fields and every work kind', async () => {
    const runs = [
      makeRun({ workerId: 'worker-1', startedAt: 2000, completedAt: 3000, status: 'completed' }),
      makeRun({ id: 'run-2', work: { kind: 'turn', sessionId: 'session-1' }, status: 'queued' }),
    ];
    for (const run of runs) {
      await repo.save(run);
    }

    for (const run of runs) {
      expect(await repo.getById(run.id)).toEqual(run);
    }
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing run on save', async () => {
    await repo.save(makeRun());
    await repo.save(makeRun({ status: 'failed', completedAt: 4000 }));

    expect((await repo.getById('run-1'))?.status).toBe('failed');
  });

  it('lists runs of a ticket ordered by attempt', async () => {
    await repo.save(makeRun({ id: 'run-2', attempt: 2 }));
    await repo.save(makeRun({ id: 'run-1', attempt: 1 }));
    await repo.save(makeRun({ id: 'run-3', work: { kind: 'ticket', ticketId: 'ticket-2' } }));
    await repo.save(makeRun({ id: 'run-4', work: { kind: 'turn', sessionId: 'session-1' } }));

    const runs = await repo.listByTicket('ticket-1');
    expect(runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
  });

  it('reports the latest attempt, zero when the ticket never ran', async () => {
    expect(await repo.latestAttempt('ticket-1')).toBe(0);

    await repo.save(makeRun({ id: 'run-1', attempt: 1 }));
    await repo.save(makeRun({ id: 'run-2', attempt: 3 }));
    await repo.save(makeRun({ id: 'run-3', work: { kind: 'ticket', ticketId: 'ticket-2' } }));

    expect(await repo.latestAttempt('ticket-1')).toBe(3);
  });
});
