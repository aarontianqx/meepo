import type { UsageSummary } from '../../domain/runs/usage.js';
import type { Run } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { RunQuery, RunRepository } from '../../domain/runs/run-repository.js';

export interface RunRow {
  id: string;
  work: string;
  attempt: number;
  worker_id: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  lease_expires_at: number | null;
  terminal_reason: string | null;
  last_client_seq: number;
  usage: string | null;
  initiator_ids: string;
  merged_source_ids: string;
  merged_into_run_id: string | null;
}

export function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    lastClientSeq: row.last_client_seq,
    usage: row.usage ? (JSON.parse(row.usage) as Run['usage']) : undefined,
    initiatorIds: JSON.parse(row.initiator_ids) as string[],
    mergedSourceIds: JSON.parse(row.merged_source_ids) as string[],
    mergedIntoRunId: row.merged_into_run_id ?? undefined,
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
        `INSERT INTO runs (
          id, work, attempt, worker_id, status, created_at, started_at, completed_at, lease_expires_at, terminal_reason, last_client_seq, usage, initiator_ids, merged_source_ids, merged_into_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET work=excluded.work, attempt=excluded.attempt, worker_id=excluded.worker_id,
          status=excluded.status, started_at=excluded.started_at, completed_at=excluded.completed_at,
          lease_expires_at=excluded.lease_expires_at, terminal_reason=excluded.terminal_reason,
          last_client_seq=MAX(runs.last_client_seq, excluded.last_client_seq), usage=COALESCE(excluded.usage, runs.usage),
          initiator_ids=excluded.initiator_ids, merged_source_ids=excluded.merged_source_ids, merged_into_run_id=excluded.merged_into_run_id
          WHERE runs.status NOT IN ('completed','failed','merged','dropped') OR excluded.status=runs.status`
      )
      .run(
        run.id,
        JSON.stringify(run.work),
        run.attempt,
        run.workerId ?? null,
        run.status,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.leaseExpiresAt ?? null,
        run.terminalReason ?? null,
        run.lastClientSeq ?? 0,
        run.usage ? JSON.stringify(run.usage) : null,
        JSON.stringify(run.initiatorIds ?? []),
        JSON.stringify(run.mergedSourceIds ?? []),
        run.mergedIntoRunId ?? null
      );
  }

  async list(query: RunQuery = {}): Promise<Run[]> {
    const where: string[] = [],
      values: (string | number)[] = [];
    if (query.workerId) {
      where.push('worker_id=?');
      values.push(query.workerId);
    }
    if (query.sessionId) {
      where.push("json_extract(work,'$.turnRef.sessionId')=?");
      values.push(query.sessionId);
    }
    if (query.expiredBefore !== undefined) {
      where.push("status IN ('queued','dispatched','running') AND lease_expires_at<=?");
      values.push(query.expiredBefore);
    }
    if (query.activeOrIds) {
      where.push(
        "(status IN ('queued','dispatched','running') OR id IN (SELECT value FROM json_each(?)))"
      );
      values.push(JSON.stringify(query.activeOrIds));
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`
        )
        .all(...values) as RunRow[]
    ).map(rowToRun);
  }

  async usage(sessionIds: string[], ticketIds: string[]) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS runCount, COUNT(usage) AS reportedRunCount,
      COALESCE(SUM(json_extract(usage,'$.inputTokens')),0) AS inputTokens,
      COALESCE(SUM(json_extract(usage,'$.outputTokens')),0) AS outputTokens,
      COALESCE(SUM(json_extract(usage,'$.costUsd')),0) AS costUsd,
      COUNT(json_extract(usage,'$.costUsd')) AS costReportedRunCount
      FROM runs WHERE json_extract(work,'$.turnRef.sessionId') IN (SELECT value FROM json_each(?))
      OR json_extract(work,'$.ticketId') IN (SELECT value FROM json_each(?))`
      )
      .get(JSON.stringify(sessionIds), JSON.stringify(ticketIds)) as UsageSummary;
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
