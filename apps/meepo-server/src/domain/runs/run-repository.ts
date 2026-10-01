import type { Run } from '@meepo/core';

export interface RunRepository {
  list(): Promise<Run[]>;
  save(run: Run): Promise<void>;
  getById(id: string): Promise<Run | undefined>;
  listByTicket(ticketId: string): Promise<Run[]>;
  /** Highest attempt number recorded for a ticket; 0 when it never dispatched. */
  latestAttempt(ticketId: string): Promise<number>;
}
