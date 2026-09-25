import type { Ticket } from '@meepo/core';

import type { TicketRepository } from '../../domain/tickets/ticket-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryTicketRepository extends MemoryTable<Ticket> implements TicketRepository {
  async listBySpace(spaceId: string): Promise<Ticket[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }

  async listPending(): Promise<Ticket[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'pending');
  }
}
