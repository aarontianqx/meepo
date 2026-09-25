import type { WorkerEnrollmentToken } from '@meepo/core';

import type { EnrollmentTokenRepository } from '../../domain/enrollments/enrollment-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryEnrollmentTokenRepository
  extends MemoryTable<WorkerEnrollmentToken>
  implements EnrollmentTokenRepository
{
  async getByToken(token: string): Promise<WorkerEnrollmentToken | undefined> {
    const all = await this.list();
    return all.find((row) => row.token === token);
  }

  async listBySpace(spaceId: string): Promise<WorkerEnrollmentToken[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceIds.includes(spaceId));
  }
}
