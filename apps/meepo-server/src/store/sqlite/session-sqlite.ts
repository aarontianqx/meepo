import type { Session } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { SessionRepository } from '../../domain/sessions/session-repository.js';

interface SessionRow {
  id: string;
  space_id: string;
  kind: string;
  chat_id: string;
  thread_id: string;
  bound_worker_id: string | null;
  status: string;
  created_at: number;
  last_active_at: number;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind as Session['kind'],
    chatId: row.chat_id,
    threadId: row.thread_id,
    boundWorkerId: row.bound_worker_id ?? undefined,
    status: row.status as Session['status'],
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async save(session: Session): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          id, space_id, kind, chat_id, thread_id, bound_worker_id,
          status, created_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.spaceId,
        session.kind,
        session.chatId,
        session.threadId,
        session.boundWorkerId ?? null,
        session.status,
        session.createdAt,
        session.lastActiveAt
      );
  }

  async getById(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  async getByThread(
    spaceId: string,
    chatId: string,
    threadId: string
  ): Promise<Session | undefined> {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE space_id = ? AND chat_id = ? AND thread_id = ?')
      .get(spaceId, chatId, threadId) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  async listBySpace(spaceId: string): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE space_id = ?')
      .all(spaceId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
