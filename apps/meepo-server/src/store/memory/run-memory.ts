import type { Run } from '@meepo/core';

import { summarizeUsage } from '../../domain/runs/usage.js';
import type { RunQuery, RunRepository } from '../../domain/runs/run-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryRunRepository extends MemoryTable<Run> implements RunRepository {
  async list(query: RunQuery = {}): Promise<Run[]> {
    return (await super.list()).filter(
      (r) =>
        (!query.workerId || r.workerId === query.workerId) &&
        (!query.sessionId ||
          (r.work.kind === 'turn' && r.work.turnRef.sessionId === query.sessionId)) &&
        (query.expiredBefore === undefined ||
          (['queued', 'dispatched', 'running'].includes(r.status) &&
            r.leaseExpiresAt !== undefined &&
            r.leaseExpiresAt <= query.expiredBefore)) &&
        (!query.activeOrIds ||
          ['queued', 'dispatched', 'running'].includes(r.status) ||
          query.activeOrIds.includes(r.id))
    );
  }
  async usage(sessionIds: string[], ticketIds: string[]) {
    return summarizeUsage(await this.list(), new Set(sessionIds), new Set(ticketIds));
  }
  async listByTicket(ticketId: string): Promise<Run[]> {
    const all = await this.list();
    return all
      .filter((row) => row.work.kind === 'ticket' && row.work.ticketId === ticketId)
      .sort((a, b) => a.attempt - b.attempt);
  }

  async latestAttempt(ticketId: string): Promise<number> {
    const runs = await this.listByTicket(ticketId);
    return runs.reduce((latest, run) => Math.max(latest, run.attempt), 0);
  }
}
