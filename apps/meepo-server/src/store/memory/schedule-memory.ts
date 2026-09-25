import type { Schedule } from '@meepo/core';

import type { ScheduleRepository } from '../../domain/schedule/schedule-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryScheduleRepository extends MemoryTable<Schedule> implements ScheduleRepository {
  async listBySpace(spaceId: string): Promise<Schedule[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }

  async listActive(): Promise<Schedule[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'active');
  }
}
