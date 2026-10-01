import type { Database } from 'better-sqlite3';
import type { ReceiptRepository, TicketReceipt } from '../../domain/tickets/receipt-service.js';

export class SqliteReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: Database) {}
  pending(): TicketReceipt[] {
    return (
      this.db
        .prepare('SELECT * FROM ticket_receipts WHERE delivered = 0 ORDER BY timestamp')
        .all() as { run_id: string; session_id: string; content: string; timestamp: number }[]
    ).map((r) => ({
      runId: r.run_id,
      sessionId: r.session_id,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }
  delivered(runId: string): void {
    this.db.prepare('UPDATE ticket_receipts SET delivered = 1 WHERE run_id = ?').run(runId);
  }
  TxDeliverClosed(receipt: TicketReceipt): void {
    this.db.transaction(() => {
      const updated = this.db
        .prepare('UPDATE ticket_receipts SET delivered = 1 WHERE run_id = ? AND delivered = 0')
        .run(receipt.runId);
      if (!updated.changes) return;
      this.db
        .prepare(
          `INSERT INTO session_events (session_id, seq, type, payload, timestamp)
        VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE session_id = ?), 'system_note', ?, ?)`
        )
        .run(
          receipt.sessionId,
          receipt.sessionId,
          JSON.stringify({ content: receipt.content, receiptRunId: receipt.runId }),
          receipt.timestamp
        );
    })();
  }
}

/** Called inside the same transaction as the ticket state transition. */
export function enqueueTicketReceipt(
  db: Database,
  ticketId: string,
  status: string,
  summary: string,
  now: number
): void {
  const ticket = db
    .prepare('SELECT origin_session_id, attempt FROM tickets WHERE id=?')
    .get(ticketId) as { origin_session_id: string | null; attempt: number } | undefined;
  if (!ticket?.origin_session_id) return;
  db.prepare(
    'INSERT OR IGNORE INTO ticket_receipts (run_id, session_id, content, timestamp) VALUES (?, ?, ?, ?)'
  ).run(
    `ticket:${ticketId}:${ticket.attempt}:${status}`,
    ticket.origin_session_id,
    `<ticket-result ticketId="${ticketId}" status="${status}">\n${summary}\n</ticket-result>`,
    now
  );
}
