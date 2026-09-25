import type { CronJob } from '@meepo/core';

export interface CronRepository {
  save(job: CronJob): Promise<void>;
  getById(id: string): Promise<CronJob | undefined>;
  listActive(): Promise<CronJob[]>;
  listActiveBySession(sessionId: string): Promise<CronJob[]>;
}
