import type { WorkerNode } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteWorkerRepository } from '../worker-sqlite.js';

function makeWorker(overrides: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: 'worker-1',
    spaceIds: ['space-1'],
    hostname: 'node-a',
    tags: ['gpu'],
    maxSlots: 4,
    activeSlots: 1,
    status: 'online',
    lastHeartbeatAt: 1000,
    version: '0.1.0',
    ...overrides,
  };
}

describe('SqliteWorkerRepository', () => {
  let db: Database;
  let repo: SqliteWorkerRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteWorkerRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a worker by id', async () => {
    await repo.save(makeWorker());

    expect(await repo.getById('worker-1')).toEqual(makeWorker());
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing worker on save', async () => {
    await repo.save(makeWorker());
    await repo.save(makeWorker({ status: 'busy', activeSlots: 4 }));

    const found = await repo.getById('worker-1');
    expect(found?.status).toBe('busy');
    expect(found?.activeSlots).toBe(4);
    expect(await repo.list()).toHaveLength(1);
  });

  it('lists all workers', async () => {
    await repo.save(makeWorker());
    await repo.save(makeWorker({ id: 'worker-2', spaceIds: [] }));

    expect(await repo.list()).toHaveLength(2);
  });

  it('lists only workers serving the given space', async () => {
    await repo.save(makeWorker());
    await repo.save(makeWorker({ id: 'worker-2', spaceIds: ['space-1', 'space-2'] }));
    await repo.save(makeWorker({ id: 'worker-3', spaceIds: ['space-2'] }));
    await repo.save(makeWorker({ id: 'worker-4', spaceIds: [] }));

    const serving = await repo.listServingSpace('space-1');
    expect(serving.map((worker) => worker.id).sort()).toEqual(['worker-1', 'worker-2']);
    expect(await repo.listServingSpace('space-unknown')).toEqual([]);
  });
});
