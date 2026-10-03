import { conflict } from '../../domain/errors.js';
import type { Ticket } from '@meepo/core';

import type { TicketRepository, TicketRequestKey } from '../../domain/tickets/ticket-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryTicketRepository extends MemoryTable<Ticket> implements TicketRepository {
  private readonly requests = new Map<string, { fingerprint: string; ticket: Ticket }>();
  async create(ticket: Ticket, request?: TicketRequestKey): Promise<Ticket> {
    const key = JSON.stringify([ticket.spaceId, request?.key]);
    const previous = request ? this.requests.get(key) : undefined;
    if (previous) {
      if (previous.fingerprint !== request!.fingerprint)
        throw conflict('Idempotency-Key reused with a different payload');
      return (await this.getById(previous.ticket.id))!;
    }
    if (request) this.requests.set(key, { fingerprint: request.fingerprint, ticket });
    await this.save(ticket);
    return ticket;
  }
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

  async listPending(pendingBefore?: number): Promise<Ticket[]> {
    const all = await this.list();
    return all.filter(
      (row) =>
        row.status === 'pending' &&
        (pendingBefore === undefined || row.pendingSince <= pendingBefore)
    );
  }
}
