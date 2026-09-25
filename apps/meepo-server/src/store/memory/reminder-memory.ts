import type { Reminder } from '@meepo/core';

import type { ReminderRepository } from '../../domain/schedule/reminder-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryReminderRepository extends MemoryTable<Reminder> implements ReminderRepository {
  async listScheduled(): Promise<Reminder[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'scheduled');
  }

  async listBySpace(spaceId: string): Promise<Reminder[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }
}
