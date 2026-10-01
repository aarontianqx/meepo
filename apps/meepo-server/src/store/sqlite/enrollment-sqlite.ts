import { createHash } from 'node:crypto';
import type { WorkerEnrollmentToken } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { EnrollmentTokenRepository } from '../../domain/enrollments/enrollment-repository.js';

interface EnrollmentTokenRow {
  id: string;
  space_ids: string;
  issued_by_user_id: string;
  label: string | null;
  token: string;
  revoked_at: number | null;
  worker_id: string | null;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

function rowToToken(row: EnrollmentTokenRow): WorkerEnrollmentToken {
  return {
    id: row.id,
    spaceIds: JSON.parse(row.space_ids) as string[],
    issuedByUserId: row.issued_by_user_id,
    label: row.label ?? undefined,
    token: row.token,
    revokedAt: row.revoked_at ?? undefined,
    workerId: row.worker_id ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export class SqliteEnrollmentTokenRepository implements EnrollmentTokenRepository {
  constructor(private readonly db: Database) {}

  async touch(id: string, now: number): Promise<void> {
    this.db
      .prepare('UPDATE enrollment_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL')
      .run(now, id);
  }

  async save(token: WorkerEnrollmentToken): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO enrollment_tokens (
          id, space_ids, issued_by_user_id, label, token, expires_at, created_at, last_used_at, revoked_at, worker_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token.id,
        JSON.stringify(token.spaceIds),
        token.issuedByUserId,
        token.label ?? null,
        token.token.startsWith('sha256:') ? token.token : hashToken(token.token),
        token.expiresAt ?? null,
        token.createdAt,
        token.lastUsedAt ?? null,
        token.revokedAt ?? null,
        token.workerId ?? null
      );
  }

  async getByToken(token: string): Promise<WorkerEnrollmentToken | undefined> {
    const row = this.db
      .prepare('SELECT * FROM enrollment_tokens WHERE token = ?')
      .get(hashToken(token)) as EnrollmentTokenRow | undefined;
    return row ? rowToToken(row) : undefined;
  }

  async getById(id: string): Promise<WorkerEnrollmentToken | undefined> {
    const row = this.db.prepare('SELECT * FROM enrollment_tokens WHERE id = ?').get(id) as
      EnrollmentTokenRow | undefined;
    return row ? rowToToken(row) : undefined;
  }

  async bindWorker(id: string, workerId: string): Promise<boolean> {
    return (
      this.db
        .prepare(
          'UPDATE enrollment_tokens SET worker_id = ? WHERE id = ? AND revoked_at IS NULL AND (worker_id IS NULL OR worker_id = ?) AND NOT EXISTS (SELECT 1 FROM enrollment_tokens t WHERE t.worker_id=? AND t.id<>?)'
        )
        .run(workerId, id, workerId, workerId, id).changes === 1
    );
  }

  async listBySpace(spaceId: string): Promise<WorkerEnrollmentToken[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM enrollment_tokens
         WHERE EXISTS (SELECT 1 FROM json_each(enrollment_tokens.space_ids) WHERE value = ?)`
      )
      .all(spaceId) as EnrollmentTokenRow[];
    return rows.map(rowToToken);
  }
}

function hashToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token).digest('hex');
}
