import type { Reminder } from '@meepo/core';

export interface ReminderRepository {
  save(reminder: Reminder): Promise<void>;
  getById(id: string): Promise<Reminder | undefined>;
  listScheduled(): Promise<Reminder[]>;
  listBySpace(spaceId: string): Promise<Reminder[]>;
}
