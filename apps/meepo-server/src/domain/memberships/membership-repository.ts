import type { SpaceMember } from '@meepo/core';

export interface MembershipRepository {
  save(member: SpaceMember): Promise<void>;
  get(spaceId: string, userId: string): Promise<SpaceMember | undefined>;
  listBySpace(spaceId: string): Promise<SpaceMember[]>;
  listByUser(userId: string): Promise<SpaceMember[]>;
}
