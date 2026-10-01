import { randomUUID } from 'node:crypto';

import type { Ticket } from '@meepo/core';

import { DomainError, conflict, notFound, validation } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { TicketRepository } from './ticket-repository.js';

export interface CreateTicketInput {
  idempotent?: boolean;
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
  /** Session the result reports back to, when created from one */
  originSessionId?: string;
}

export interface CompleteTicketInput {
  branch?: string;
  prUrl?: string;
  commitSha?: string;
  summary: string;
}

export class TicketService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly spaces: SpaceRepository
  ) {}

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const space = await this.spaces.getById(input.spaceId);
    if (!space) throw validation(`Unknown space: ${input.spaceId}`);
    if (typeof input.title !== 'string' || !input.title.trim())
      throw validation('Ticket title must not be empty');
    if (typeof input.objective !== 'string' || !input.objective.trim())
      throw validation('Ticket objective must not be empty');
    if (
      input.requiredTags &&
      (!Array.isArray(input.requiredTags) || input.requiredTags.some((t) => typeof t !== 'string'))
    )
      throw validation('requiredTags must be strings');
    if (input.idempotent !== undefined && typeof input.idempotent !== 'boolean')
      throw validation('idempotent must be boolean');
    const now = Date.now();
    const ticket: Ticket = {
      id: randomUUID(),
      spaceId: input.spaceId,
      title: input.title.trim(),
      objective: input.objective,
      contextSummary: input.contextSummary,
      requiredTags: input.requiredTags ?? space.requiredTags,
      originSessionId: input.originSessionId,
      status: 'pending',
      pendingSince: now,
      attempt: 0,
      idempotent: input.idempotent ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.tickets.save(ticket);
    return ticket;
  }

  async getTicket(id: string): Promise<Ticket> {
    const ticket = await this.tickets.getById(id);
    if (!ticket) throw notFound(`Ticket not found: ${id}`);
    return ticket;
  }

  async listTickets(spaceId?: string): Promise<Ticket[]> {
    return spaceId ? this.tickets.listBySpace(spaceId) : this.tickets.list();
  }

  async claimTicket(id: string, workerId: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'pending') {
      throw conflict(`Ticket ${id} is ${ticket.status}, only pending tickets can be claimed`);
    }
    return this.transition(ticket, 'claimed', workerId);
  }

  async markRunning(id: string, workerId: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status === 'running' && ticket.assignedWorkerId === workerId) return ticket;
    if (ticket.status !== 'claimed' || ticket.assignedWorkerId !== workerId) {
      throw conflict(`Ticket ${id} is not claimed by worker ${workerId}`);
    }
    return this.transition(ticket, 'running', workerId);
  }

  async completeTicket(id: string, result: CompleteTicketInput): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'running') {
      throw conflict(`Ticket ${id} is ${ticket.status}, only running tickets can complete`);
    }
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = 'completed';
    ticket.result = result;
    ticket.updatedAt = Date.now();
    ticket.completedAt = Date.now();
    await this.tickets.save(ticket, expected);
    return ticket;
  }

  async failTicket(id: string, error: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'running' && ticket.status !== 'claimed') {
      throw conflict(`Ticket ${id} is ${ticket.status}, only claimed/running tickets can fail`);
    }
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = 'failed';
    ticket.result = { summary: error };
    ticket.updatedAt = Date.now();
    ticket.completedAt = Date.now();
    await this.tickets.save(ticket, expected);
    return ticket;
  }

  /** Retries a manual_review ticket with a fresh pending interval, within the attempt limit. */
  async requeueTicket(id: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'manual_review')
      throw conflict('Only manual_review tickets may be retried');
    if ((ticket.attempt ?? 0) >= 3) throw conflict('Maximum attempts exhausted');
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = 'pending';
    ticket.assignedWorkerId = undefined;
    ticket.updatedAt = Date.now();
    ticket.pendingSince = ticket.updatedAt;
    await this.tickets.save(ticket, expected);
    return ticket;
  }

  async cancelTicket(id: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    // Retrying a cancel also lets the route resend abort if the earlier response was lost.
    if (ticket.status === 'cancelled') return ticket;
    if (!['pending', 'claimed', 'running', 'manual_review'].includes(ticket.status))
      throw conflict('Ticket cannot be cancelled in this state');
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = 'cancelled';
    ticket.terminalReason = 'cancelled';
    ticket.completedAt = Date.now();
    ticket.updatedAt = ticket.completedAt;
    try {
      await this.tickets.save(ticket, expected);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') {
        const current = await this.getTicket(id);
        if (current.status === 'cancelled') return current;
      }
      throw error;
    }
    return ticket;
  }

  async abandonTicket(id: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'manual_review')
      throw conflict('Only manual_review tickets may be abandoned');
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = 'failed';
    ticket.terminalReason = 'abandoned';
    ticket.completedAt = Date.now();
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket, expected);
    return ticket;
  }

  private async transition(
    ticket: Ticket,
    status: Ticket['status'],
    workerId: string
  ): Promise<Ticket> {
    const expected = { status: ticket.status, attempt: ticket.attempt ?? 0 };
    ticket.status = status;
    ticket.assignedWorkerId = workerId;
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket, expected);
    return ticket;
  }
}
