import type { Run } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { RunRepository } from '../../domain/runs/run-repository.js';

interface RunRow {
  id: string;
  work: string;
  attempt: number;
  worker_id: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    work: JSON.parse(row.work) as Run['work'],
    attempt: row.attempt,
    workerId: row.worker_id ?? undefined,
    status: row.status as Run['status'],
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Database) {}

  async save(run: Run): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (
          id, work, attempt, worker_id, status, created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        JSON.stringify(run.work),
        run.attempt,
        run.workerId ?? null,
        run.status,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null
      );
  }

  async getById(id: string): Promise<Run | undefined> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async listByTicket(ticketId: string): Promise<Run[]> {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE json_extract(work, '$.ticketId') = ? ORDER BY attempt ASC`)
      .all(ticketId) as RunRow[];
    return rows.map(rowToRun);
  }

  async latestAttempt(ticketId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT MAX(attempt) AS latest FROM runs WHERE json_extract(work, '$.ticketId') = ?`)
      .get(ticketId) as { latest: number | null };
    return row.latest ?? 0;
  }
}
