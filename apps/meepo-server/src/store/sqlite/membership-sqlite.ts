import type { SpaceMember } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { MembershipRepository } from '../../domain/memberships/membership-repository.js';

interface MembershipRow {
  space_id: string;
  user_id: string;
  role: string;
  created_at: number;
}

function rowToMember(row: MembershipRow): SpaceMember {
  return {
    spaceId: row.space_id,
    userId: row.user_id,
    role: row.role as SpaceMember['role'],
    createdAt: row.created_at,
  };
}

export class SqliteMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async save(member: SpaceMember): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memberships (space_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(member.spaceId, member.userId, member.role, member.createdAt);
  }

  async get(spaceId: string, userId: string): Promise<SpaceMember | undefined> {
    const row = this.db
      .prepare('SELECT * FROM memberships WHERE space_id = ? AND user_id = ?')
      .get(spaceId, userId) as MembershipRow | undefined;
    return row ? rowToMember(row) : undefined;
  }

  async listBySpace(spaceId: string): Promise<SpaceMember[]> {
    const rows = this.db
      .prepare('SELECT * FROM memberships WHERE space_id = ?')
      .all(spaceId) as MembershipRow[];
    return rows.map(rowToMember);
  }

  async listByUser(userId: string): Promise<SpaceMember[]> {
    const rows = this.db
      .prepare('SELECT * FROM memberships WHERE user_id = ?')
      .all(userId) as MembershipRow[];
    return rows.map(rowToMember);
  }
}
