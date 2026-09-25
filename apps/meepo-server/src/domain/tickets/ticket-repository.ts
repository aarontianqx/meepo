import type { Ticket } from '@meepo/core';

export interface TicketRepository {
  save(ticket: Ticket): Promise<void>;
  getById(id: string): Promise<Ticket | undefined>;
  list(): Promise<Ticket[]>;
  listBySpace(spaceId: string): Promise<Ticket[]>;
  listPending(): Promise<Ticket[]>;
}
