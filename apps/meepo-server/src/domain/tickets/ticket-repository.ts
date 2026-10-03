import type { Ticket } from '@meepo/core';

export interface TicketRequestKey {
  key: string;
  fingerprint: string;
}
export interface TicketRepository {
  /** Atomically create or return the ticket for this space/key; mismatched payloads conflict. */
  create(ticket: Ticket, request?: TicketRequestKey): Promise<Ticket>;
  save(ticket: Ticket, expected?: { status: Ticket['status']; attempt: number }): Promise<void>;
  getById(id: string): Promise<Ticket | undefined>;
  list(): Promise<Ticket[]>;
  listBySpace(spaceId: string): Promise<Ticket[]>;
  listPending(pendingBefore?: number): Promise<Ticket[]>;
}
