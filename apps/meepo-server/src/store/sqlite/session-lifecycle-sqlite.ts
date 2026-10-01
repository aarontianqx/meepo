import type { Database } from 'better-sqlite3';
import type {
  LifecycleEffects,
  SessionLifecycleRepository,
} from '../../domain/sessions/session-lifecycle.js';
import { conflict, notFound } from '../../domain/errors.js';
import { rowToRun, type RunRow } from './run-sqlite.js';
import { rowToSession, type SessionRow } from './session-sqlite.js';

const emptyEffects = (): LifecycleEffects => ({ interrupted: [], detached: [], notes: [] });

export class SqliteSessionLifecycle implements SessionLifecycleRepository {
  constructor(private readonly db: Database) {}
  TxReset(
    sessionId: string,
    newId: string,
    anchorMessageId: string,
    ingress: { channelId: string; messageId: string },
    now: number
  ) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as
        SessionRow | undefined;
      if (!row) throw notFound('Session not found');
      if (
        this.db
          .prepare('SELECT 1 FROM processed_messages WHERE channel_id=? AND message_id=?')
          .get(ingress.channelId, ingress.messageId)
      )
        return { session: rowToSession(row), effects: emptyEffects(), duplicate: true };
      if (row.status === 'closed' || row.kind !== 'main')
        throw conflict('Only an active main session can reset');
      const { effects } = this.TxClose(sessionId, now);
      this.db
        .prepare(
          `INSERT INTO sessions(id,space_id,kind,chat_id,thread_id,bound_worker_id,status,created_at,last_active_at,anchor_message_id,prewarm_message_id,channel_id)
        VALUES(?,?,?,?,?,NULL,'active',?,?,?,NULL,?)`
        )
        .run(
          newId,
          row.space_id,
          row.kind,
          row.chat_id,
          row.thread_id,
          now,
          now,
          anchorMessageId,
          row.channel_id
        );
      this.db
        .prepare('INSERT INTO processed_messages(channel_id,message_id,processed_at) VALUES(?,?,?)')
        .run(ingress.channelId, ingress.messageId, now);
      this.db
        .prepare(
          'INSERT INTO message_outbox(id,channel_id,message_id,text,created_at) VALUES(?,?,?,?,?)'
        )
        .run(
          `new:${newId}`,
          ingress.channelId,
          anchorMessageId,
          '已关闭当前会话并开启新会话。',
          now
        );
      return {
        session: rowToSession(
          this.db.prepare('SELECT * FROM sessions WHERE id=?').get(newId) as SessionRow
        ),
        effects,
        duplicate: false,
      };
    })();
  }
  TxDeleteSpace(spaceId: string, now: number): LifecycleEffects {
    return this.db.transaction(() => {
      const effects = emptyEffects();
      const sessions = this.db.prepare('SELECT id FROM sessions WHERE space_id=?').all(spaceId) as {
        id: string;
      }[];
      for (const session of sessions) {
        const e = this.TxClose(session.id, now).effects;
        effects.interrupted.push(...e.interrupted);
        effects.detached.push(...e.detached);
      }
      const tickets = this.db
        .prepare(
          "SELECT r.* FROM runs r JOIN tickets t ON t.id=json_extract(r.work,'$.ticketId') WHERE t.space_id=? AND r.status IN ('queued','dispatched','running')"
        )
        .all(spaceId) as RunRow[];
      for (const r of tickets) {
        this.db
          .prepare(
            "UPDATE runs SET status='failed',terminal_reason='space_deleted',completed_at=? WHERE id=?"
          )
          .run(now, r.id);
        effects.interrupted.push(
          rowToRun({ ...r, status: 'failed', terminal_reason: 'space_deleted', completed_at: now })
        );
      }
      this.db
        .prepare(
          "UPDATE tickets SET status='cancelled',terminal_reason='space_deleted',updated_at=?,completed_at=? WHERE space_id=? AND status IN ('pending','claimed','running','manual_review')"
        )
        .run(now, now, spaceId);
      this.db.prepare("UPDATE schedules SET status='deleted' WHERE space_id=?").run(spaceId);
      this.db
        .prepare(
          "UPDATE memory_entries SET deleted=1,content='',revision=revision+1 WHERE space_id=?"
        )
        .run(spaceId);
      this.db.prepare("DELETE FROM channels WHERE json_extract(data,'$.spaceId')=?").run(spaceId);
      for (const t of this.db.prepare('SELECT id,space_ids FROM enrollment_tokens').all() as {
        id: string;
        space_ids: string;
      }[]) {
        const remaining = (JSON.parse(t.space_ids) as string[]).filter((id) => id !== spaceId);
        this.db
          .prepare(
            'UPDATE enrollment_tokens SET space_ids=?,revoked_at=CASE WHEN ?=0 THEN ? ELSE revoked_at END WHERE id=?'
          )
          .run(JSON.stringify(remaining), remaining.length, now, t.id);
      }
      this.db.prepare('DELETE FROM memberships WHERE space_id=?').run(spaceId);
      this.db.prepare('DELETE FROM webhook_tokens WHERE space_id=?').run(spaceId);
      this.db.prepare('DELETE FROM spaces WHERE id=?').run(spaceId);
      return effects;
    })();
  }
  TxRebind(spaceId: string, workerId: string, now: number): LifecycleEffects {
    return this.db.transaction(() => {
      const effects = emptyEffects();
      const sessions = this.db
        .prepare(
          "SELECT * FROM sessions WHERE space_id = ? AND kind = 'main' AND status != 'closed' AND bound_worker_id IS NOT ?"
        )
        .all(spaceId, workerId) as SessionRow[];
      for (const row of sessions) {
        this.interrupt(row, now, false, effects);
        this.db
          .prepare('UPDATE sessions SET bound_worker_id = ?, last_active_at = ? WHERE id = ?')
          .run(workerId, now, row.id);
        this.db
          .prepare(
            "UPDATE runs SET worker_id = ?, status = 'queued', lease_expires_at = NULL WHERE json_extract(work, '$.turnRef.sessionId') = ? AND status IN ('queued', 'dispatched')"
          )
          .run(workerId, row.id);
        const { seq } = this.db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?'
          )
          .get(row.id) as { seq: number };
        const payload = {
          content:
            'This session migrated to another worker. Previous local files may no longer exist.',
          historyOnly: true,
        };
        this.db
          .prepare(
            "INSERT INTO session_events (session_id, seq, type, payload, timestamp) VALUES (?, ?, 'system_note', ?, ?)"
          )
          .run(row.id, seq, JSON.stringify(payload), now);
        effects.notes.push({
          sessionId: row.id,
          workerId,
          event: { seq, type: 'system_note', payload, timestamp: now },
        });
      }
      this.db
        .prepare('UPDATE spaces SET bound_worker_id = ?, updated_at = ? WHERE id = ?')
        .run(workerId, now, spaceId);
      return effects;
    })();
  }
  TxClose(sessionId: string, now: number) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
        SessionRow | undefined;
      if (!row) throw notFound('Session not found');
      const effects = emptyEffects();
      this.interrupt(row, now, true, effects);
      this.db
        .prepare(
          "UPDATE sessions SET status = 'closed', bound_worker_id = NULL, last_active_at = ? WHERE id = ?"
        )
        .run(now, sessionId);
      this.db
        .prepare(
          "UPDATE schedules SET status = 'deleted' WHERE json_extract(action, '$.kind') = 'resume_session' AND json_extract(action, '$.sessionId') = ?"
        )
        .run(sessionId);
      this.db.prepare('DELETE FROM dispatch_queue WHERE session_id = ?').run(sessionId);
      return {
        session: rowToSession({
          ...row,
          status: 'closed',
          bound_worker_id: null,
          last_active_at: now,
        }),
        effects,
      };
    })();
  }
  private interrupt(row: SessionRow, now: number, close: boolean, effects: LifecycleEffects): void {
    const states = close ? "('queued', 'dispatched', 'running')" : "('running')";
    const runs = this.db
      .prepare(
        `SELECT * FROM runs WHERE json_extract(work, '$.turnRef.sessionId') = ? AND status IN ${states}`
      )
      .all(row.id) as RunRow[];
    for (const run of runs) {
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', terminal_reason = 'interrupted', completed_at = ? WHERE id = ?"
        )
        .run(now, run.id);
      this.db.prepare('DELETE FROM dispatch_queue WHERE id = ?').run(run.id);
      effects.interrupted.push(
        rowToRun({ ...run, status: 'failed', terminal_reason: 'interrupted', completed_at: now })
      );
    }
    if (row.bound_worker_id)
      effects.detached.push({ sessionId: row.id, workerId: row.bound_worker_id });
  }
}
