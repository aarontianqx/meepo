import type { Ticket } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { TicketRepository } from '../../domain/tickets/ticket-repository.js';

interface TicketRow {
  id: string;
  space_id: string;
  title: string;
  objective: string;
  context_summary: string | null;
  required_tags: string;
  origin_session_id: string | null;
  status: string;
  assigned_worker_id: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    objective: row.objective,
    contextSummary: row.context_summary ?? undefined,
    requiredTags: JSON.parse(row.required_tags) as string[],
    originSessionId: row.origin_session_id ?? undefined,
    status: row.status as Ticket['status'],
    assignedWorkerId: row.assigned_worker_id ?? undefined,
    result: row.result ? (JSON.parse(row.result) as Ticket['result']) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class SqliteTicketRepository implements TicketRepository {
  constructor(private readonly db: Database) {}

  async save(ticket: Ticket): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tickets (
          id, space_id, title, objective, context_summary, required_tags, origin_session_id,
          status, assigned_worker_id, result, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticket.id,
        ticket.spaceId,
        ticket.title,
        ticket.objective,
        ticket.contextSummary ?? null,
        JSON.stringify(ticket.requiredTags),
        ticket.originSessionId ?? null,
        ticket.status,
        ticket.assignedWorkerId ?? null,
        ticket.result ? JSON.stringify(ticket.result) : null,
        ticket.createdAt,
        ticket.updatedAt,
        ticket.completedAt ?? null
      );
  }

  async getById(id: string): Promise<Ticket | undefined> {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
      TicketRow | undefined;
    return row ? rowToTicket(row) : undefined;
  }

  async list(): Promise<Ticket[]> {
    const rows = this.db.prepare('SELECT * FROM tickets').all() as TicketRow[];
    return rows.map(rowToTicket);
  }

  async listBySpace(spaceId: string): Promise<Ticket[]> {
    const rows = this.db
      .prepare('SELECT * FROM tickets WHERE space_id = ?')
      .all(spaceId) as TicketRow[];
    return rows.map(rowToTicket);
  }

  async listPending(): Promise<Ticket[]> {
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE status = 'pending'`)
      .all() as TicketRow[];
    return rows.map(rowToTicket);
  }
}
