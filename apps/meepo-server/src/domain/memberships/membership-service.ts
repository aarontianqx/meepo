import type { SpaceMember, SpaceRole } from '@meepo/core';

import { notFound, unauthorized, validation } from '../errors.js';
import type { MembershipRepository } from './membership-repository.js';

export class MembershipService {
  constructor(private readonly memberships: MembershipRepository) {}

  /** Assigns the unique owner of a space; called exactly once at space creation. */
  async addOwner(spaceId: string, userId: string): Promise<SpaceMember> {
    return this.save(spaceId, userId, 'owner');
  }

  /** Adds a manager to a space. Ownership transfer is a separate future operation. */
  async addMember(spaceId: string, userId: string, actorUserId: string): Promise<SpaceMember> {
    if (!userId.trim()) throw validation('userId must not be empty');
    await this.requireManager(spaceId, actorUserId);
    const existing = await this.memberships.get(spaceId, userId);
    if (existing) throw validation(`User ${userId} is already a member of space ${spaceId}`);
    return this.save(spaceId, userId, 'manager');
  }

  async listMembers(spaceId: string, actorUserId: string): Promise<SpaceMember[]> {
    await this.requireMember(spaceId, actorUserId);
    return this.memberships.listBySpace(spaceId);
  }

  async listMemberships(userId: string): Promise<SpaceMember[]> {
    return this.memberships.listByUser(userId);
  }

  /** Every member (owner or manager) holds management rights over the space. */
  async requireManager(spaceId: string, userId: string): Promise<void> {
    await this.requireMember(spaceId, userId);
  }

  private async requireMember(spaceId: string, userId: string): Promise<SpaceMember> {
    const member = await this.memberships.get(spaceId, userId);
    if (!member) {
      const any = await this.memberships.listBySpace(spaceId);
      if (any.length === 0) throw notFound(`Space not found: ${spaceId}`);
      throw unauthorized(`User ${userId} is not a member of space ${spaceId}`);
    }
    return member;
  }

  private async save(spaceId: string, userId: string, role: SpaceRole): Promise<SpaceMember> {
    const member: SpaceMember = { spaceId, userId, role, createdAt: Date.now() };
    await this.memberships.save(member);
    return member;
  }
}
