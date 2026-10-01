import type { SpaceMember, SpaceRole } from '@meepo/core';

import { notFound, unauthorized, validation } from '../errors.js';
import type { MembershipRepository } from './membership-repository.js';

export class MembershipService {
  constructor(private readonly memberships: MembershipRepository) {}

  /** Assigns the unique owner of a space; called exactly once at space creation. */
  async addOwner(spaceId: string, userId: string): Promise<SpaceMember> {
    return this.save(spaceId, userId, 'owner');
  }

  /** Adds an operator to a space. Ownership transfer is a separate future operation. */
  async addMember(spaceId: string, userId: string, actorUserId: string): Promise<SpaceMember> {
    if (typeof userId !== 'string' || !userId.trim()) throw validation('userId must not be empty');
    await this.requireOperator(spaceId, actorUserId);
    const existing = await this.memberships.get(spaceId, userId);
    if (existing) throw validation(`User ${userId} is already a member of space ${spaceId}`);
    return this.save(spaceId, userId, 'operator');
  }

  async listMembers(spaceId: string, actorUserId: string): Promise<SpaceMember[]> {
    await this.requireMember(spaceId, actorUserId);
    return this.memberships.listBySpace(spaceId);
  }

  async listMemberships(userId: string): Promise<SpaceMember[]> {
    return this.memberships.listByUser(userId);
  }

  /** Every member (owner or operator) holds management rights over the space. */
  async requireOperator(spaceId: string, userId: string): Promise<void> {
    await this.requireMember(spaceId, userId);
  }

  async requireMember(spaceId: string, userId: string): Promise<SpaceMember> {
    const member = await this.memberships.get(spaceId, userId);
    if (!member) {
      const any = await this.memberships.listBySpace(spaceId);
      if (any.length === 0) throw notFound(`Space not found: ${spaceId}`);
      throw unauthorized(`User ${userId} is not a member of space ${spaceId}`);
    }
    return member;
  }

  async requireOwner(spaceId: string, userId: string): Promise<void> {
    const member = await this.requireMember(spaceId, userId);
    if (member.role !== 'owner') throw unauthorized('Space owner required');
  }

  async removeMember(spaceId: string, userId: string, actor: string): Promise<void> {
    await this.requireOwner(spaceId, actor);
    const member = await this.requireMember(spaceId, userId);
    if (member.role === 'owner') throw validation('Transfer ownership before removing the owner');
    await this.memberships.remove(spaceId, userId);
  }
  async transferOwnership(spaceId: string, to: string, actor: string): Promise<void> {
    await this.requireOwner(spaceId, actor);
    if (typeof to !== 'string' || !to.trim()) throw validation('New owner userId is required');
    if (actor === to || !(await this.memberships.transfer(spaceId, actor, to)))
      throw validation('New owner must be another space member');
  }
  private async save(spaceId: string, userId: string, role: SpaceRole): Promise<SpaceMember> {
    const member: SpaceMember = { spaceId, userId, role, createdAt: Date.now() };
    await this.memberships.save(member);
    return member;
  }
}
