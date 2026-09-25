import type { CronJob } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { CronRepository } from '../../domain/schedule/cron-repository.js';

interface CronJobRow {
  id: string;
  session_id: string;
  space_id: string;
  cron: string;
  prompt: string;
  recurring: number;
  timezone: string;
  status: string;
  created_at: number;
  last_fired_at: number | null;
}

function rowToCronJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    spaceId: row.space_id,
    cron: row.cron,
    prompt: row.prompt,
    recurring: row.recurring === 1,
    timezone: row.timezone,
    status: row.status as CronJob['status'],
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at ?? undefined,
  };
}

export class SqliteCronRepository implements CronRepository {
  constructor(private readonly db: Database) {}

  async save(job: CronJob): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cron_jobs (
          id, session_id, space_id, cron, prompt, recurring,
          timezone, status, created_at, last_fired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        job.id,
        job.sessionId,
        job.spaceId,
        job.cron,
        job.prompt,
        job.recurring ? 1 : 0,
        job.timezone,
        job.status,
        job.createdAt,
        job.lastFiredAt ?? null
      );
  }

  async getById(id: string): Promise<CronJob | undefined> {
    const row = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as
      CronJobRow | undefined;
    return row ? rowToCronJob(row) : undefined;
  }

  async listActive(): Promise<CronJob[]> {
    const rows = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE status = 'active'`)
      .all() as CronJobRow[];
    return rows.map(rowToCronJob);
  }

  async listActiveBySession(sessionId: string): Promise<CronJob[]> {
    const rows = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE status = 'active' AND session_id = ?`)
      .all(sessionId) as CronJobRow[];
    return rows.map(rowToCronJob);
  }
}
