import type { UsageSummary } from './usage.js';
import type { Run } from '@meepo/core';

export interface RunQuery {
  workerId?: string;
  sessionId?: string;
  expiredBefore?: number;
  activeOrIds?: string[];
}
export interface RunRepository {
  list(query?: RunQuery): Promise<Run[]>;
  usage(sessionIds: string[], ticketIds: string[]): Promise<UsageSummary>;
  save(run: Run): Promise<void>;
  getById(id: string): Promise<Run | undefined>;
  listByTicket(ticketId: string): Promise<Run[]>;
  /** Highest attempt number recorded for a ticket; 0 when it never dispatched. */
  latestAttempt(ticketId: string): Promise<number>;
}
