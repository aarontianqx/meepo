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
    if (
      !Array.isArray(input.spaceIds) ||
      input.spaceIds.length === 0 ||
      input.spaceIds.some((id) => typeof id !== 'string' || !id.trim())
    )
      throw validation('Enrollment must cover at least one space');
    if (
      input.expiresAt !== undefined &&
      (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now())
    )
      throw validation('expiresAt must be a future timestamp');
    if (input.label !== undefined && typeof input.label !== 'string')
      throw validation('label must be a string');
    for (const spaceId of input.spaceIds) {
      const space = await this.spaces.getById(spaceId);
      if (!space) throw validation(`Unknown space: ${spaceId}`);
      await this.memberships.requireOperator(spaceId, issuedByUserId);
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

  async list(spaceId: string, userId: string): Promise<Omit<WorkerEnrollmentToken, 'token'>[]> {
    await this.memberships.requireOperator(spaceId, userId);
    return (await this.tokens.listBySpace(spaceId)).map(({ token: _token, ...entry }) => entry);
  }

  async revoke(id: string, userId: string): Promise<void> {
    const token = await this.tokens.getById(id);
    if (!token) throw validation('Unknown enrollment token');
    for (const spaceId of token.spaceIds) await this.memberships.requireOperator(spaceId, userId);
    token.revokedAt = Date.now();
    await this.tokens.save(token);
  }

  /** Resolves a presented token to its enrollment record, enforcing expiry. */
  async resolveEnrollment(tokenValue: string, workerId?: string): Promise<WorkerEnrollmentToken> {
    const token = await this.tokens.getByToken(tokenValue);
    if (token?.revokedAt !== undefined) throw unauthorized('Enrollment token was revoked');
    if (!token) throw unauthorized('Invalid enrollment token');
    if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) {
      throw unauthorized('Enrollment token has expired');
    }
    if (workerId && !(await this.tokens.bindWorker(token.id, workerId)))
      throw unauthorized('Enrollment token belongs to another worker');
    if (workerId) token.workerId = workerId;
    token.lastUsedAt = Date.now();
    await this.tokens.touch(token.id, token.lastUsedAt);
    return token;
  }
}
