import type { WorkerEnrollmentToken } from '@meepo/core';

import type { EnrollmentTokenRepository } from '../../domain/enrollments/enrollment-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryEnrollmentTokenRepository
  extends MemoryTable<WorkerEnrollmentToken>
  implements EnrollmentTokenRepository
{
  async touch(id: string, now: number): Promise<void> {
    const token = this.rows.get(id);
    if (token && !token.revokedAt) token.lastUsedAt = now;
  }

  async bindWorker(id: string, workerId: string): Promise<boolean> {
    if ((await this.list()).some((t) => t.id !== id && t.workerId === workerId)) return false;
    const token = this.rows.get(id);
    if (!token || (token.workerId && token.workerId !== workerId)) return false;
    token.workerId = workerId;
    return true;
  }

  async getByToken(token: string): Promise<WorkerEnrollmentToken | undefined> {
    const all = await this.list();
    return all.find((row) => row.token === token);
  }

  async listBySpace(spaceId: string): Promise<WorkerEnrollmentToken[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceIds.includes(spaceId));
  }
}
