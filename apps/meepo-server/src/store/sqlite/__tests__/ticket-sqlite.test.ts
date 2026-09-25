import type { Ticket } from '@meepo/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database.js';
import { SqliteTicketRepository } from '../ticket-sqlite.js';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1',
    spaceId: 'space-1',
    title: 'Fix the bug',
    objective: 'Reproduce and fix',
    requiredTags: [],
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('SqliteTicketRepository', () => {
  let db: Database;
  let repo: SqliteTicketRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTicketRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a ticket by id', async () => {
    await repo.save(makeTicket());

    expect(await repo.getById('ticket-1')).toEqual(makeTicket());
  });

  it('round-trips optional fields', async () => {
    const ticket = makeTicket({
      contextSummary: 'context',
      assignedWorkerId: 'worker-1',
      status: 'completed',
      result: { branch: 'fix/bug', prUrl: 'https://example.com/pr/1', summary: 'done' },
      completedAt: 2000,
      updatedAt: 2000,
    });
    await repo.save(ticket);

    expect(await repo.getById(ticket.id)).toEqual(ticket);
  });

  it('returns undefined for a missing id', async () => {
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('overwrites an existing ticket on save', async () => {
    await repo.save(makeTicket());
    await repo.save(makeTicket({ status: 'claimed', assignedWorkerId: 'worker-1' }));

    const found = await repo.getById('ticket-1');
    expect(found?.status).toBe('claimed');
    expect(await repo.list()).toHaveLength(1);
  });

  it('lists tickets by space', async () => {
    await repo.save(makeTicket());
    await repo.save(makeTicket({ id: 'ticket-2' }));
    await repo.save(makeTicket({ id: 'ticket-3', spaceId: 'space-2' }));

    const bySpace = await repo.listBySpace('space-1');
    expect(bySpace.map((ticket) => ticket.id).sort()).toEqual(['ticket-1', 'ticket-2']);
  });

  it('lists only pending tickets', async () => {
    await repo.save(makeTicket());
    await repo.save(makeTicket({ id: 'ticket-2', status: 'running' }));
    await repo.save(makeTicket({ id: 'ticket-3', status: 'failed' }));
    await repo.save(makeTicket({ id: 'ticket-4', spaceId: 'space-2' }));

    const pending = await repo.listPending();
    expect(pending.map((ticket) => ticket.id).sort()).toEqual(['ticket-1', 'ticket-4']);
  });
});
