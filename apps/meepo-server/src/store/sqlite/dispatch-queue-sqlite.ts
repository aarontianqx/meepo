import type { TurnDispatchEnvelope } from '@meepo/protocol';
import type { Database } from 'better-sqlite3';

import type {
  DispatchQueueRepository,
  QueuedDispatch,
} from '../../domain/dispatch/dispatch-queue-repository.js';

interface DispatchQueueRow {
  id: string;
  session_id: string;
  envelope: string;
  queued_at: number;
}

function rowToDispatch(row: DispatchQueueRow): QueuedDispatch {
  return {
    id: row.id,
    sessionId: row.session_id,
    envelope: JSON.parse(row.envelope) as TurnDispatchEnvelope,
    queuedAt: row.queued_at,
  };
}

export class SqliteDispatchQueueRepository implements DispatchQueueRepository {
  constructor(private readonly db: Database) {}

  async enqueue(item: QueuedDispatch): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dispatch_queue (id, session_id, envelope, queued_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(item.id, item.sessionId, JSON.stringify(item.envelope), item.queuedAt);
  }

  async listBySession(sessionId: string): Promise<QueuedDispatch[]> {
    const rows = this.db
      .prepare('SELECT * FROM dispatch_queue WHERE session_id = ? ORDER BY queued_at ASC')
      .all(sessionId) as DispatchQueueRow[];
    return rows.map(rowToDispatch);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM dispatch_queue WHERE session_id = ?').run(sessionId);
  }

  async listSessionIds(): Promise<string[]> {
    const rows = this.db.prepare('SELECT DISTINCT session_id FROM dispatch_queue').all() as Array<{
      session_id: string;
    }>;
    return rows.map((row) => row.session_id);
  }
}
