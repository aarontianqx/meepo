import { conflict } from '../../domain/errors.js';
import type { Ticket } from '@meepo/core';

import type { TicketRepository } from '../../domain/tickets/ticket-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryTicketRepository extends MemoryTable<Ticket> implements TicketRepository {
  async save(
    ticket: Ticket,
    expected?: { status: Ticket['status']; attempt: number }
  ): Promise<void> {
    if (expected) {
      const current = await this.getById(ticket.id);
      if (
        !current ||
        current.status !== expected.status ||
        (current.attempt ?? 0) !== expected.attempt
      )
        throw conflict('Ticket changed concurrently');
    }
    await super.save(ticket);
  }
  async listBySpace(spaceId: string): Promise<Ticket[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }

  async listPending(): Promise<Ticket[]> {
    const all = await this.list();
    return all.filter((row) => row.status === 'pending');
  }
}
