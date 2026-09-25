import type { Run } from '@meepo/core';

import type { RunRepository } from '../../domain/runs/run-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryRunRepository extends MemoryTable<Run> implements RunRepository {
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
