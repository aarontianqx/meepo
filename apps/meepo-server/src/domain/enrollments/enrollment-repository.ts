import type { WorkerEnrollmentToken } from '@meepo/core';

export interface EnrollmentTokenRepository {
  save(token: WorkerEnrollmentToken): Promise<void>;
  getByToken(token: string): Promise<WorkerEnrollmentToken | undefined>;
  listBySpace(spaceId: string): Promise<WorkerEnrollmentToken[]>;
}
