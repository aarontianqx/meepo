import type { Database } from 'better-sqlite3';
import type { FireCommitter, ScheduleWork } from '../../domain/schedule/fire-committer.js';
import { SqliteDispatchCommitter } from './dispatch-committer-sqlite.js';

export class SqliteFireCommitter implements FireCommitter {
  constructor(private readonly db: Database) {}
  TxFire(work: ScheduleWork): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE schedules SET status = ?, last_fired_at = ? WHERE id = ? AND status = 'active' AND last_fired_at IS ?"
        )
        .run(
          work.schedule.status,
          work.schedule.lastFiredAt,
          work.schedule.id,
          work.expectedLastFiredAt ?? null
        );
      if (!changed.changes) return false;
      this.db
        .prepare(
          'INSERT INTO schedule_fires (id, schedule_id, work_id, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(
          work.fireId,
          work.schedule.id,
          work.ticket?.id ?? work.turn?.run.id,
          work.schedule.lastFiredAt
        );
      if (work.ticket) {
        const t = work.ticket;
        this.db
          .prepare(
            `INSERT INTO tickets (id, space_id, title, objective, context_summary, required_tags, origin_session_id, status, created_at, updated_at, pending_since)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
          )
          .run(
            t.id,
            t.spaceId,
            t.title,
            t.objective,
            t.contextSummary ?? null,
            JSON.stringify(t.requiredTags),
            t.originSessionId ?? null,
            t.createdAt,
            t.updatedAt,
            t.pendingSince
          );
      }
      if (work.turn) {
        const { run, queued, message } = work.turn;
        new SqliteDispatchCommitter(this.db).TxEnqueueTurn(
          run,
          queued,
          message,
          undefined,
          'system_note'
        );
        this.db
          .prepare(
            'UPDATE sessions SET bound_worker_id = COALESCE(bound_worker_id, ?) WHERE id = ?'
          )
          .run(run.workerId ?? null, queued.sessionId);
      }
      return true;
    })();
  }
}
