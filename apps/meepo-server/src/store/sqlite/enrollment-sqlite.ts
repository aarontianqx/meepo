import type { WorkerEnrollmentToken } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { EnrollmentTokenRepository } from '../../domain/enrollments/enrollment-repository.js';

interface EnrollmentTokenRow {
  id: string;
  space_ids: string;
  issued_by_user_id: string;
  label: string | null;
  token: string;
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
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export class SqliteEnrollmentTokenRepository implements EnrollmentTokenRepository {
  constructor(private readonly db: Database) {}

  async save(token: WorkerEnrollmentToken): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO enrollment_tokens (
          id, space_ids, issued_by_user_id, label, token, expires_at, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token.id,
        JSON.stringify(token.spaceIds),
        token.issuedByUserId,
        token.label ?? null,
        token.token,
        token.expiresAt ?? null,
        token.createdAt,
        token.lastUsedAt ?? null
      );
  }

  async getByToken(token: string): Promise<WorkerEnrollmentToken | undefined> {
    const row = this.db.prepare('SELECT * FROM enrollment_tokens WHERE token = ?').get(token) as
      EnrollmentTokenRow | undefined;
    return row ? rowToToken(row) : undefined;
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
