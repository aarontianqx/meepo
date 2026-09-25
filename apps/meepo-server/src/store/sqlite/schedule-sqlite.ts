import type { Schedule, ScheduleAction, ScheduleTiming } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { ScheduleRepository } from '../../domain/schedule/schedule-repository.js';

interface ScheduleRow {
  id: string;
  space_id: string;
  timing: string;
  action: string;
  status: string;
  created_by_user_id: string;
  created_at: number;
  last_fired_at: number | null;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    spaceId: row.space_id,
    timing: JSON.parse(row.timing) as ScheduleTiming,
    action: JSON.parse(row.action) as ScheduleAction,
    status: row.status as Schedule['status'],
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at ?? undefined,
  };
}

export class SqliteScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Database) {}

  async save(schedule: Schedule): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO schedules (
          id, space_id, timing, action, status, created_by_user_id, created_at, last_fired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        schedule.id,
        schedule.spaceId,
        JSON.stringify(schedule.timing),
        JSON.stringify(schedule.action),
        schedule.status,
        schedule.createdByUserId,
        schedule.createdAt,
        schedule.lastFiredAt ?? null
      );
  }

  async getById(id: string): Promise<Schedule | undefined> {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  async list(): Promise<Schedule[]> {
    const rows = this.db.prepare('SELECT * FROM schedules').all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  async listBySpace(spaceId: string): Promise<Schedule[]> {
    const rows = this.db
      .prepare('SELECT * FROM schedules WHERE space_id = ?')
      .all(spaceId) as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  async listActive(): Promise<Schedule[]> {
    const rows = this.db
      .prepare(`SELECT * FROM schedules WHERE status = 'active'`)
      .all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }
}
