import { conflict } from '../../domain/errors.js';
import type { Session } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { SessionRepository } from '../../domain/sessions/session-repository.js';

export interface SessionRow {
  id: string;
  channel_id: string;
  space_id: string;
  kind: string;
  chat_id: string;
  thread_id: string;
  anchor_message_id: string | null;
  prewarm_message_id: string | null;
  bound_worker_id: string | null;
  status: string;
  created_at: number;
  last_active_at: number;
}

export function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    channelId: row.channel_id || undefined,
    windowId: `${row.channel_id || 'feishu'}:${row.chat_id}:${row.thread_id}`,
    spaceId: row.space_id,
    kind: row.kind as Session['kind'],
    chatId: row.chat_id,
    threadId: row.thread_id,
    anchorMessageId: row.anchor_message_id ?? undefined,
    prewarmMessageId: row.prewarm_message_id ?? undefined,
    boundWorkerId: row.bound_worker_id ?? undefined,
    status: row.status as Session['status'],
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async save(
    session: Session,
    expected?: Pick<Session, 'status' | 'boundWorkerId'>
  ): Promise<void> {
    this.db.transaction(() => {
      const old = this.db
        .prepare('SELECT status,bound_worker_id FROM sessions WHERE id=?')
        .get(session.id) as { status: string; bound_worker_id: string | null } | undefined;
      if (
        (old?.status === 'closed' && session.status !== 'closed') ||
        (expected &&
          (!old ||
            old.status !== expected.status ||
            (old.bound_worker_id ?? undefined) !== expected.boundWorkerId))
      )
        throw conflict('Session changed; retry the operation');
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sessions (
          id, space_id, kind, chat_id, thread_id, anchor_message_id, prewarm_message_id,
          bound_worker_id, status, created_at, last_active_at, channel_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.id,
          session.spaceId,
          session.kind,
          session.chatId,
          session.threadId,
          session.anchorMessageId ?? null,
          session.prewarmMessageId ?? null,
          session.boundWorkerId ?? null,
          session.status,
          session.createdAt,
          session.lastActiveAt,
          session.channelId ?? ''
        );
    })();
  }

  async getById(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  async getByThread(
    spaceId: string,
    chatId: string,
    threadId: string,
    channelId?: string
  ): Promise<Session | undefined> {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE space_id = ? AND chat_id = ? AND thread_id = ? AND channel_id = ? AND status != 'closed' ORDER BY last_active_at DESC LIMIT 1"
      )
      .get(spaceId, chatId, threadId, channelId ?? '') as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  async listBySpace(spaceId: string): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE space_id = ?')
      .all(spaceId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
