import type { WorkerEnrollmentToken } from '@meepo/core';

export interface EnrollmentTokenRepository {
  getById(id: string): Promise<WorkerEnrollmentToken | undefined>;
  bindWorker(id: string, workerId: string): Promise<boolean>;
  touch(id: string, now: number): Promise<void>;
  save(token: WorkerEnrollmentToken): Promise<void>;
  getByToken(token: string): Promise<WorkerEnrollmentToken | undefined>;
  listBySpace(spaceId: string): Promise<WorkerEnrollmentToken[]>;
}
