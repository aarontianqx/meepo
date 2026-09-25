import type { Database } from 'better-sqlite3';

import type {
  SessionEventRecord,
  SessionEventRepository,
} from '../../domain/sessions/session-event-repository.js';

interface SessionEventRow {
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  timestamp: number;
}

function rowToEvent(row: SessionEventRow): SessionEventRecord {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    timestamp: row.timestamp,
  };
}

export class SqliteSessionEventRepository implements SessionEventRepository {
  constructor(private readonly db: Database) {}

  async append(
    sessionId: string,
    type: string,
    payload: unknown,
    timestamp: number = Date.now()
  ): Promise<SessionEventRecord> {
    return this.db.transaction(() => {
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

  async listBySession(sessionId: string): Promise<SessionEventRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as SessionEventRow[];
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
