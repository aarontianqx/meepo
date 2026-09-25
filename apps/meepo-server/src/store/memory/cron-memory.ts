import type { CronJob } from '@meepo/core';

import type { CronRepository } from '../../domain/schedule/cron-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryCronRepository extends MemoryTable<CronJob> implements CronRepository {
  async listActive(): Promise<CronJob[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'active');
  }

  async listActiveBySession(sessionId: string): Promise<CronJob[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'active' && row.sessionId === sessionId);
  }
}
