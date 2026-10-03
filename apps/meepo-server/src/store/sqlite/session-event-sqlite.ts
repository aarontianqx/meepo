import type { Database } from 'better-sqlite3';

import type {
  EventQuery,
  SessionEventRecord,
  SessionEventRepository,
} from '../../domain/sessions/session-event-repository.js';

interface SessionEventRow {
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  timestamp: number;
  run_id: string | null;
  client_seq: number | null;
}

function rowToEvent(row: SessionEventRow): SessionEventRecord {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    timestamp: row.timestamp,
    runId: row.run_id ?? undefined,
    clientSeq: row.client_seq ?? undefined,
  };
}

export class SqliteSessionEventRepository implements SessionEventRepository {
  constructor(private readonly db: Database) {}

  async hasImage(sessionId: string, messageId: string, fileKey: string): Promise<boolean> {
    return !!this.db
      .prepare(
        `SELECT 1 FROM session_events e, json_each(e.payload,'$.images') i
      WHERE e.session_id=? AND e.type IN ('message','user_message')
      AND json_extract(i.value,'$.messageId')=? AND json_extract(i.value,'$.fileKey')=? LIMIT 1`
      )
      .get(sessionId, messageId, fileKey);
  }
  async append(
    sessionId: string,
    type: string,
    payload: unknown,
    timestamp: number = Date.now()
  ): Promise<SessionEventRecord> {
    return this.db.transaction(() => {
      const externalId = (payload as { externalMessageId?: string } | undefined)?.externalMessageId;
      if (externalId) {
        const prior = this.db
          .prepare(
            "SELECT * FROM session_events WHERE session_id=? AND json_extract(payload,'$.externalMessageId')=?"
          )
          .get(sessionId, externalId) as SessionEventRow | undefined;
        if (prior) return rowToEvent(prior);
      }
      const seq = this.latestSeqSync(sessionId) + 1;
      const storedPayload = payload === undefined ? null : payload;
      this.db
        .prepare(
          `INSERT INTO session_events (session_id, seq, type, payload, timestamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(sessionId, seq, type, JSON.stringify(storedPayload), timestamp);
      return { sessionId, seq, type, payload: storedPayload, timestamp };
    })();
  }

  async listBySession(sessionId: string, query: EventQuery = {}): Promise<SessionEventRecord[]> {
    const clauses = ['session_id = ?', 'seq > ?'];
    const args: (string | number)[] = [sessionId, query.afterSeq ?? 0];
    if (query.beforeSeq !== undefined) {
      clauses.push(
        query.includeHistoryNotes
          ? "(seq < ? OR (type='system_note' AND json_extract(payload,'$.historyOnly')=1))"
          : 'seq < ?'
      );
      args.push(query.beforeSeq);
    } else if (query.beforeTimestamp !== undefined) {
      clauses.push('timestamp < ?');
      args.push(query.beforeTimestamp);
    }
    if (query.type) {
      clauses.push('type=?');
      args.push(query.type);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`
      )
      .all(...args, query.limit ?? -1) as SessionEventRow[];
    return rows.map(rowToEvent);
  }

  async latestSeq(sessionId: string): Promise<number> {
    return this.latestSeqSync(sessionId);
  }

  private latestSeqSync(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?')
      .get(sessionId) as { seq: number };
    return row.seq;
  }
}
