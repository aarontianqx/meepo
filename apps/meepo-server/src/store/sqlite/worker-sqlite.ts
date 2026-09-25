import type { WorkerNode } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { WorkerRepository } from '../../domain/workers/worker-repository.js';

interface WorkerRow {
  id: string;
  space_ids: string;
  hostname: string;
  tags: string;
  max_slots: number;
  active_slots: number;
  status: string;
  last_heartbeat_at: number;
  version: string;
}

function rowToWorker(row: WorkerRow): WorkerNode {
  return {
    id: row.id,
    spaceIds: JSON.parse(row.space_ids) as string[],
    hostname: row.hostname,
    tags: JSON.parse(row.tags) as string[],
    maxSlots: row.max_slots,
    activeSlots: row.active_slots,
    status: row.status as WorkerNode['status'],
    lastHeartbeatAt: row.last_heartbeat_at,
    version: row.version,
  };
}

export class SqliteWorkerRepository implements WorkerRepository {
  constructor(private readonly db: Database) {}

  async save(worker: WorkerNode): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workers (
          id, space_ids, hostname, tags, max_slots, active_slots,
          status, last_heartbeat_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        worker.id,
        JSON.stringify(worker.spaceIds),
        worker.hostname,
        JSON.stringify(worker.tags),
        worker.maxSlots,
        worker.activeSlots,
        worker.status,
        worker.lastHeartbeatAt,
        worker.version
      );
  }

  async getById(id: string): Promise<WorkerNode | undefined> {
    const row = this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as
      WorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  async list(): Promise<WorkerNode[]> {
    const rows = this.db.prepare('SELECT * FROM workers').all() as WorkerRow[];
    return rows.map(rowToWorker);
  }

  async listServingSpace(spaceId: string): Promise<WorkerNode[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM workers
         WHERE EXISTS (SELECT 1 FROM json_each(workers.space_ids) WHERE value = ?)`
      )
      .all(spaceId) as WorkerRow[];
    return rows.map(rowToWorker);
  }
}
