import type { SpaceMember } from '@meepo/core';

import type { MembershipRepository } from '../../domain/memberships/membership-repository.js';

export class MemoryMembershipRepository implements MembershipRepository {
  private readonly rows = new Map<string, SpaceMember>();

  private static key(spaceId: string, userId: string): string {
    return `${spaceId}${userId}`;
  }

  async save(member: SpaceMember): Promise<void> {
    this.rows.set(MemoryMembershipRepository.key(member.spaceId, member.userId), {
      ...member,
    });
  }

  async get(spaceId: string, userId: string): Promise<SpaceMember | undefined> {
    const row = this.rows.get(MemoryMembershipRepository.key(spaceId, userId));
    return row ? { ...row } : undefined;
  }

  async listBySpace(spaceId: string): Promise<SpaceMember[]> {
    return [...this.rows.values()]
      .filter((row) => row.spaceId === spaceId)
      .map((row) => ({ ...row }));
  }

  async listByUser(userId: string): Promise<SpaceMember[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map((row) => ({ ...row }));
  }
}
