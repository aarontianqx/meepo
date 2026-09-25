import { randomBytes, randomUUID } from 'node:crypto';

import type { WorkerEnrollmentToken } from '@meepo/core';

import { unauthorized, validation } from '../errors.js';
import type { MembershipService } from '../memberships/membership-service.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { EnrollmentTokenRepository } from './enrollment-repository.js';

export interface IssueEnrollmentInput {
  spaceIds: string[];
  label?: string;
  expiresAt?: number;
}

export class EnrollmentService {
  constructor(
    private readonly tokens: EnrollmentTokenRepository,
    private readonly spaces: SpaceRepository,
    private readonly memberships: MembershipService
  ) {}

  /**
   * Issues a pre-shared enrollment token. The plaintext token is returned once
   * here and presented by workers at registration time.
   */
  async issueEnrollment(
    input: IssueEnrollmentInput,
    issuedByUserId: string
  ): Promise<WorkerEnrollmentToken> {
    if (input.spaceIds.length === 0) throw validation('Enrollment must cover at least one space');
    for (const spaceId of input.spaceIds) {
      const space = await this.spaces.getById(spaceId);
      if (!space) throw validation(`Unknown space: ${spaceId}`);
      await this.memberships.requireManager(spaceId, issuedByUserId);
    }
    const token: WorkerEnrollmentToken = {
      id: randomUUID(),
      spaceIds: [...input.spaceIds],
      issuedByUserId,
      label: input.label,
      token: `mep_${randomBytes(24).toString('base64url')}`,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    };
    await this.tokens.save(token);
    return token;
  }

  /** Resolves a presented token to its enrollment record, enforcing expiry. */
  async resolveEnrollment(tokenValue: string): Promise<WorkerEnrollmentToken> {
    const token = await this.tokens.getByToken(tokenValue);
    if (!token) throw unauthorized('Invalid enrollment token');
    if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) {
      throw unauthorized('Enrollment token has expired');
    }
    token.lastUsedAt = Date.now();
    await this.tokens.save(token);
    return token;
  }
}
