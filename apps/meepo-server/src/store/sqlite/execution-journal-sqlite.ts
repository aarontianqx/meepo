import { enqueueTicketReceipt } from './receipt-sqlite.js';
import { rowToRun, type RunRow } from './run-sqlite.js';
import { isTerminalRun, type Run, type Ticket } from '@meepo/core';
import { boundedPayload } from '@meepo/protocol';
import type { CanonicalEvent, SequencedWorkerEvent, StreamAck } from '@meepo/protocol';
import type { Database } from 'better-sqlite3';

import type { ExecutionJournal } from '../../domain/runs/execution-journal.js';

interface Row {
  work: string;
  worker_id: string | null;
  status: Run['status'];
  last_client_seq: number;
  lease_expires_at: number | null;
}

/** The ACK is returned only after the event, transcript and projection commit. */
export class SqliteExecutionJournal implements ExecutionJournal {
  constructor(private readonly db: Database) {}

  TxInterrupt(runId: string, reason: string, now: number): Run | undefined {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE runs SET status='failed', terminal_reason=?, completed_at=? WHERE id=? AND status IN ('queued','dispatched','running')"
        )
        .run(reason, now, runId);
      if (!changed.changes) return undefined;
      this.db.prepare('DELETE FROM dispatch_queue WHERE id=?').run(runId);
      return rowToRun(this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow);
    })();
  }
  TxRenew(workerId: string, runIds: string[], durationMs: number, now: number): void {
    this.db.transaction(() => {
      const update = this.db.prepare(
        "UPDATE runs SET lease_expires_at=? WHERE id=? AND worker_id=? AND status IN ('dispatched','running') AND (lease_expires_at IS NULL OR lease_expires_at>?)"
      );
      for (const id of runIds) update.run(now + durationMs, id, workerId, now);
    })();
  }
  TxExpire(run: Run, ticket?: Ticket): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE runs SET status = 'failed', terminal_reason = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'dispatched', 'running') AND lease_expires_at <= ?"
        )
        .run(run.terminalReason, run.completedAt, run.id, run.completedAt);
      if (!changed.changes) return false;
      this.db.prepare('DELETE FROM dispatch_queue WHERE id = ?').run(run.id);
      if (ticket) {
        const updated = this.db
          .prepare(
            "UPDATE tickets SET status = ?, terminal_reason = ?, assigned_worker_id = NULL, updated_at = ?, completed_at = ?, pending_since = ? WHERE id = ? AND attempt = ? AND status IN ('claimed', 'running')"
          )
          .run(
            ticket.status,
            ticket.terminalReason ?? null,
            ticket.updatedAt,
            ticket.completedAt ?? null,
            ticket.pendingSince,
            ticket.id,
            run.attempt
          );
        if (updated.changes && ['failed', 'manual_review'].includes(ticket.status))
          enqueueTicketReceipt(
            this.db,
            ticket.id,
            ticket.status,
            ticket.terminalReason ?? 'Worker lease lost; execution outcome requires review',
            run.completedAt!
          );
      }
      return true;
    })();
  }

  TxAppend(workerId: string, event: SequencedWorkerEvent, now: number): StreamAck {
    return this.db.transaction((): StreamAck => {
      const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(event.runId) as
        Row | undefined;
      const last = row?.last_client_seq ?? 0;
      const reject = (reason: string): StreamAck => ({
        accepted: false,
        lastConfirmedClientSeq: last,
        reason,
      });
      if (!row || row.worker_id !== workerId) return reject('run_not_owned');
      if (!Number.isSafeInteger(event.clientSeq) || event.clientSeq < 1)
        return reject('invalid_sequence');
      // Lost terminal ACKs can be replayed even after the run is terminal.
      if (event.clientSeq <= last)
        return { accepted: true, duplicate: true, lastConfirmedClientSeq: last };
      if (isTerminalRun(row.status)) return reject('run_terminal');
      if (row.lease_expires_at !== null && row.lease_expires_at <= now)
        return reject('lease_expired');
      if (event.clientSeq !== last + 1) return reject('sequence_gap');

      const work = JSON.parse(row.work) as Run['work'];
      if (event.type === 'run_merged') {
        const target = this.db
          .prepare('SELECT * FROM runs WHERE id=?')
          .get(event.mergedIntoRunId) as Row | undefined;
        const targetWork = target ? (JSON.parse(target.work) as Run['work']) : undefined;
        if (
          event.mergedIntoRunId === event.runId ||
          work.kind !== 'turn' ||
          targetWork?.kind !== 'turn' ||
          target?.worker_id !== workerId ||
          isTerminalRun(target.status) ||
          targetWork.turnRef.sessionId !== work.turnRef.sessionId
        )
          return reject('invalid_merge_target');
      }
      const canonical = normalizeEvent(event);
      if (canonical) {
        this.db
          .prepare(
            'INSERT INTO run_events (run_id, client_seq, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            event.runId,
            event.clientSeq,
            canonical.type,
            JSON.stringify(canonical.payload),
            now
          );
        if (
          work.kind === 'turn' &&
          ['assistant_text', 'tool_call', 'tool_result', 'system_note'].includes(canonical.type)
        ) {
          this.db
            .prepare(
              `INSERT INTO session_events (session_id, seq, type, payload, timestamp, run_id, client_seq)
            VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE session_id = ?), ?, ?, ?, ?, ?)`
            )
            .run(
              work.turnRef.sessionId,
              work.turnRef.sessionId,
              canonical.type,
              JSON.stringify(canonical.payload),
              now,
              event.runId,
              event.clientSeq
            );
        }
      }
      this.db
        .prepare('UPDATE runs SET last_client_seq = ? WHERE id = ?')
        .run(event.clientSeq, event.runId);
      if (['run_started', 'run_failed', 'run_merged', 'run_dropped'].includes(event.type))
        this.db.prepare('DELETE FROM dispatch_queue WHERE id = ?').run(event.runId);
      if (event.type === 'run_started') {
        this.db
          .prepare(
            "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?"
          )
          .run(now, event.runId);
      }
      if (
        event.type === 'run_completed' ||
        event.type === 'run_failed' ||
        event.type === 'run_merged' ||
        event.type === 'run_dropped'
      ) {
        const status =
          event.type === 'run_completed'
            ? 'completed'
            : event.type === 'run_merged'
              ? 'merged'
              : event.type === 'run_dropped'
                ? 'dropped'
                : 'failed';
        const reason =
          event.type === 'run_failed'
            ? event.code === 'aborted'
              ? 'interrupted'
              : (event.code ?? 'error')
            : null;
        this.db
          .prepare(
            'UPDATE runs SET status = ?, completed_at = ?, terminal_reason = ?, usage = ?, merged_into_run_id = ? WHERE id = ?'
          )
          .run(
            status,
            now,
            reason,
            event.type === 'run_completed' && event.usage ? JSON.stringify(event.usage) : null,
            event.type === 'run_merged' ? event.mergedIntoRunId : null,
            event.runId
          );
        if (event.type === 'run_merged') {
          const initiators = this.db
            .prepare(
              'SELECT initiator_ids, merged_source_ids, work FROM runs WHERE id IN (?, ?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END'
            )
            .all(event.runId, event.mergedIntoRunId, event.mergedIntoRunId) as {
            initiator_ids: string;
            merged_source_ids: string;
            work: string;
          }[];
          const merged = [
            ...new Set(initiators.flatMap((r) => JSON.parse(r.initiator_ids) as string[])),
          ];
          this.db
            .prepare('UPDATE runs SET initiator_ids = ?, merged_source_ids = ? WHERE id = ?')
            .run(
              JSON.stringify(merged),
              JSON.stringify([
                ...new Set(
                  initiators.flatMap((r) => {
                    const ids = JSON.parse(r.merged_source_ids) as string[];
                    const w = JSON.parse(r.work) as Run['work'];
                    return ids.length ? ids : w.kind === 'turn' ? [w.turnRef.sourceId] : [];
                  })
                ),
              ]),
              event.mergedIntoRunId
            );
        }
      }
      if (work.kind === 'ticket') {
        if (event.type === 'run_started')
          this.db
            .prepare(
              "UPDATE tickets SET status = 'running', updated_at = ? WHERE id = ? AND status = 'claimed'"
            )
            .run(now, work.ticketId);
        if (event.type === 'run_completed' || event.type === 'run_failed') {
          const status = event.type === 'run_completed' ? 'completed' : 'failed';
          const summary =
            event.type === 'run_completed' ? (event.resultSummary ?? '') : event.error;
          const updated = this.db
            .prepare(
              "UPDATE tickets SET status = ?, result = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('claimed', 'running') AND attempt=(SELECT attempt FROM runs WHERE id=?)"
            )
            .run(status, JSON.stringify({ summary }), now, now, work.ticketId, event.runId);
          if (updated.changes) enqueueTicketReceipt(this.db, work.ticketId, status, summary, now);
        }
      }
      return { accepted: true, lastConfirmedClientSeq: event.clientSeq };
    })();
  }

  listByRun(runId: string): CanonicalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY client_seq')
      .all(runId) as { client_seq: number; type: string; payload: string; timestamp: number }[];
    return rows.map((r) => ({
      seq: r.client_seq,
      clientSeq: r.client_seq,
      runId,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      timestamp: r.timestamp,
    }));
  }
}

function normalizeEvent(
  event: SequencedWorkerEvent
): { type: string; payload: unknown } | undefined {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_execution_update':
      return undefined;
    case 'tool_execution_start':
      return {
        type: 'tool_call',
        payload: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: boundedPayload(event.args),
        },
      };
    case 'tool_execution_end':
      return {
        type: 'tool_result',
        payload: {
          toolCallId: event.toolCallId,
          result: boundedPayload(event.result),
          isError: event.isError,
        },
      };
    case 'context_note':
      return { type: 'system_note', payload: { content: event.content } };
    case 'assistant_text':
      return { type: event.type, payload: { content: event.content } };
    default:
      return { type: event.type, payload: event };
  }
}
