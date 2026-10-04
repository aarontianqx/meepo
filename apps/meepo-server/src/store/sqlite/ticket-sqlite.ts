import { conflict } from '../../domain/errors.js';
import { enqueueTicketReceipt } from './receipt-sqlite.js';
import type { Ticket } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { TicketRepository, TicketRequestKey } from '../../domain/tickets/ticket-repository.js';

interface TicketRow {
  id: string;
  attempt: number;
  idempotent: number;
  terminal_reason: string | null;
  space_id: string;
  title: string;
  objective: string;
  context_summary: string | null;
  required_tags: string;
  origin_session_id: string | null;
  status: string;
  assigned_worker_id: string | null;
  result: string | null;
  pending_since: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    attempt: row.attempt || undefined,
    idempotent: row.idempotent ? true : undefined,
    terminalReason: row.terminal_reason ?? undefined,
    spaceId: row.space_id,
    title: row.title,
    objective: row.objective,
    contextSummary: row.context_summary ?? undefined,
    requiredTags: JSON.parse(row.required_tags) as string[],
    originSessionId: row.origin_session_id ?? undefined,
    status: row.status as Ticket['status'],
    assignedWorkerId: row.assigned_worker_id ?? undefined,
    result: row.result ? (JSON.parse(row.result) as Ticket['result']) : undefined,
    pendingSince: row.pending_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class SqliteTicketRepository implements TicketRepository {
  constructor(private readonly db: Database) {}

  async create(ticket: Ticket, request?: TicketRequestKey): Promise<Ticket> {
    return this.db.transaction(() => {
      if (request) {
        const row = this.db
          .prepare('SELECT fingerprint,ticket_id FROM webhook_requests WHERE space_id=? AND key=?')
          .get(ticket.spaceId, request.key) as
          { fingerprint: string; ticket_id: string } | undefined;
        if (row) {
          if (row.fingerprint !== request.fingerprint)
            throw conflict('Idempotency-Key reused with a different payload');
          const saved = this.db.prepare('SELECT * FROM tickets WHERE id=?').get(row.ticket_id) as
            TicketRow | undefined;
          if (!saved) throw conflict('Original webhook ticket is no longer available');
          return rowToTicket(saved);
        }
      }
      this.saveRecord(ticket);
      if (request)
        this.db
          .prepare(
            'INSERT INTO webhook_requests(space_id,key,fingerprint,ticket_id,created_at) VALUES(?,?,?,?,?)'
          )
          .run(ticket.spaceId, request.key, request.fingerprint, ticket.id, Date.now());
      return ticket;
    })();
  }

  async save(
    ticket: Ticket,
    expected?: { status: Ticket['status']; attempt: number }
  ): Promise<void> {
    this.saveRecord(ticket, expected);
  }

  private saveRecord(
    ticket: Ticket,
    expected?: { status: Ticket['status']; attempt: number }
  ): void {
    this.db.transaction(() => {
      if (expected) {
        const current = this.db
          .prepare('SELECT status, attempt FROM tickets WHERE id=?')
          .get(ticket.id) as { status: string; attempt: number } | undefined;
        if (!current || current.status !== expected.status || current.attempt !== expected.attempt)
          throw conflict('Ticket changed concurrently; reload before retrying');
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO tickets (
          id, space_id, title, objective, context_summary, required_tags, origin_session_id,
          status, assigned_worker_id, result, created_at, updated_at, completed_at, attempt, idempotent, terminal_reason, pending_since
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          ticket.completedAt ?? null,
          ticket.attempt ?? 0,
          ticket.idempotent ? 1 : 0,
          ticket.terminalReason ?? null,
          ticket.pendingSince
        );
      if (['completed', 'failed', 'cancelled'].includes(ticket.status)) {
        this.db
          .prepare(
            `UPDATE runs SET status='failed', terminal_reason=?, completed_at=? WHERE json_extract(work,'$.ticketId')=? AND status IN ('queued','dispatched','running')`
          )
          .run(
            ticket.terminalReason ?? ticket.status,
            ticket.completedAt ?? ticket.updatedAt,
            ticket.id
          );
        enqueueTicketReceipt(
          this.db,
          ticket.id,
          ticket.status,
          ticket.result?.summary ?? ticket.terminalReason ?? ticket.status,
          ticket.updatedAt
        );
      }
    })();
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

  async listPending(pendingBefore?: number): Promise<Ticket[]> {
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE status = 'pending' AND pending_since <= ?`)
      .all(pendingBefore ?? Number.MAX_SAFE_INTEGER) as TicketRow[];
    return rows.map(rowToTicket);
  }
}
