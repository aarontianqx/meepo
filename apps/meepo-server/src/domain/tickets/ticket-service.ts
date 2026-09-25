import { randomUUID } from 'node:crypto';

import type { Ticket } from '@meepo/core';
import type { WorkspaceSpec } from '@meepo/protocol';

import { conflict, notFound, validation } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { TicketRepository } from './ticket-repository.js';

export interface CreateTicketInput {
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
  workspace?: WorkspaceSpec;
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
    if (!input.title.trim()) throw validation('Ticket title must not be empty');
    if (!input.objective.trim()) throw validation('Ticket objective must not be empty');
    const now = Date.now();
    const ticket: Ticket = {
      id: randomUUID(),
      spaceId: input.spaceId,
      title: input.title.trim(),
      objective: input.objective,
      contextSummary: input.contextSummary,
      workspace: input.workspace,
      requiredTags: input.requiredTags ?? space.requiredTags,
      status: 'pending',
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
    ticket.status = 'completed';
    ticket.result = result;
    ticket.updatedAt = Date.now();
    ticket.completedAt = Date.now();
    await this.tickets.save(ticket);
    return ticket;
  }

  async failTicket(id: string, error: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'running' && ticket.status !== 'claimed') {
      throw conflict(`Ticket ${id} is ${ticket.status}, only claimed/running tickets can fail`);
    }
    ticket.status = 'failed';
    ticket.result = { summary: error };
    ticket.updatedAt = Date.now();
    ticket.completedAt = Date.now();
    await this.tickets.save(ticket);
    return ticket;
  }

  /** Returns a claimed/running/failed ticket to the pending queue (e.g. worker disconnected, retry). */
  async requeueTicket(id: string): Promise<Ticket> {
    const ticket = await this.getTicket(id);
    if (ticket.status !== 'claimed' && ticket.status !== 'running' && ticket.status !== 'failed') {
      throw conflict(
        `Ticket ${id} is ${ticket.status}, only claimed/running/failed tickets can requeue`
      );
    }
    ticket.status = 'pending';
    ticket.assignedWorkerId = undefined;
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket);
    return ticket;
  }

  private async transition(
    ticket: Ticket,
    status: Ticket['status'],
    workerId: string
  ): Promise<Ticket> {
    ticket.status = status;
    ticket.assignedWorkerId = workerId;
    ticket.updatedAt = Date.now();
    await this.tickets.save(ticket);
    return ticket;
  }
}
