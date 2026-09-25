import type { Reminder, ScheduleTrigger } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { ReminderRepository } from '../../domain/schedule/reminder-repository.js';

interface ReminderRow {
  id: string;
  space_id: string;
  objective: string;
  context_summary: string | null;
  required_tags: string;
  trigger: string;
  timezone: string;
  status: string;
  created_by_user_id: string;
  created_at: number;
  last_fired_at: number | null;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    spaceId: row.space_id,
    objective: row.objective,
    contextSummary: row.context_summary ?? undefined,
    requiredTags: JSON.parse(row.required_tags) as string[],
    trigger: JSON.parse(row.trigger) as ScheduleTrigger,
    timezone: row.timezone,
    status: row.status as Reminder['status'],
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at ?? undefined,
  };
}

export class SqliteReminderRepository implements ReminderRepository {
  constructor(private readonly db: Database) {}

  async save(reminder: Reminder): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reminders (
          id, space_id, objective, context_summary, required_tags, trigger,
          timezone, status, created_by_user_id, created_at, last_fired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reminder.id,
        reminder.spaceId,
        reminder.objective,
        reminder.contextSummary ?? null,
        JSON.stringify(reminder.requiredTags),
        JSON.stringify(reminder.trigger),
        reminder.timezone,
        reminder.status,
        reminder.createdByUserId,
        reminder.createdAt,
        reminder.lastFiredAt ?? null
      );
  }

  async getById(id: string): Promise<Reminder | undefined> {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
      ReminderRow | undefined;
    return row ? rowToReminder(row) : undefined;
  }

  async listScheduled(): Promise<Reminder[]> {
    const rows = this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'scheduled'`)
      .all() as ReminderRow[];
    return rows.map(rowToReminder);
  }

  async listBySpace(spaceId: string): Promise<Reminder[]> {
    const rows = this.db
      .prepare('SELECT * FROM reminders WHERE space_id = ?')
      .all(spaceId) as ReminderRow[];
    return rows.map(rowToReminder);
  }
}
