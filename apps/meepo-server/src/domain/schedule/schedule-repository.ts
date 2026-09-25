import type { Schedule } from '@meepo/core';

export interface ScheduleRepository {
  save(schedule: Schedule): Promise<void>;
  getById(id: string): Promise<Schedule | undefined>;
  list(): Promise<Schedule[]>;
  listBySpace(spaceId: string): Promise<Schedule[]>;
  listActive(): Promise<Schedule[]>;
}
