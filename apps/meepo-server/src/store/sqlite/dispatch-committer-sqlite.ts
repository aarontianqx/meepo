import { conflict } from '../../domain/errors.js';
import type { Run, Ticket } from '@meepo/core';
import type { TranscriptMessage } from '@meepo/protocol';
import type { Database } from 'better-sqlite3';

import type { DispatchCommitter } from '../../domain/dispatch/dispatch-committer.js';
import type { QueuedDispatch } from '../../domain/dispatch/dispatch-queue-repository.js';

export class SqliteDispatchCommitter implements DispatchCommitter {
  constructor(private readonly db: Database) {}

  TxClaimTicket(ticket: Ticket, run: Run, maxSlots: number): boolean {
    return this.db.transaction(() => {
      const { count } = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM runs WHERE worker_id = ? AND status IN ('dispatched', 'running')"
        )
        .get(run.workerId) as { count: number };
      if (count >= maxSlots) return false;
      const changed = this.db
        .prepare(
          "UPDATE tickets SET status = 'claimed', attempt = ?, assigned_worker_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
        )
        .run(run.attempt, run.workerId, run.createdAt, ticket.id);
      if (!changed.changes) return false;
      this.db
        .prepare(
          'INSERT INTO runs (id, work, attempt, worker_id, status, created_at, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          run.id,
          JSON.stringify(run.work),
          run.attempt,
          run.workerId,
          run.status,
          run.createdAt,
          run.leaseExpiresAt
        );
      return true;
    })();
  }

  TxMergeQueue(
    items: QueuedDispatch[],
    envelope: QueuedDispatch['envelope'],
    workerId: string,
    leaseExpiresAt: number,
    now: number
  ): boolean {
    return this.db.transaction(() => {
      const session = this.db
        .prepare('SELECT status,bound_worker_id FROM sessions WHERE id=?')
        .get(items[0]?.sessionId) as { status: string; bound_worker_id: string | null } | undefined;
      if (
        !session ||
        session.status === 'closed' ||
        (session.bound_worker_id && session.bound_worker_id !== workerId)
      )
        return false;
      const rows = items.map(
        (item) =>
          this.db.prepare('SELECT status, initiator_ids FROM runs WHERE id = ?').get(item.id) as
            { status: string; initiator_ids: string } | undefined
      );
      if (rows.some((row) => !row || row.status !== 'queued')) return false;
      const authors = [
        ...new Set(rows.flatMap((row) => JSON.parse(row!.initiator_ids) as string[])),
      ];
      this.db
        .prepare('UPDATE dispatch_queue SET envelope = ? WHERE id = ?')
        .run(JSON.stringify(envelope), items[0].id);
      this.db
        .prepare(
          "UPDATE runs SET status = 'dispatched', worker_id = ?, lease_expires_at = ?, initiator_ids = ?, merged_source_ids = ? WHERE id = ?"
        )
        .run(
          workerId,
          leaseExpiresAt,
          JSON.stringify(authors),
          JSON.stringify(envelope.mergedSourceIds ?? []),
          items[0].id
        );
      for (const item of items.slice(1)) {
        this.db
          .prepare(
            "UPDATE runs SET status = 'merged', merged_into_run_id = ?, completed_at = ? WHERE id = ?"
          )
          .run(items[0].id, now, item.id);
        this.db.prepare('DELETE FROM dispatch_queue WHERE id = ?').run(item.id);
      }
      return true;
    })();
  }

  hasProcessedMessage(channelId: string, messageId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM processed_messages WHERE channel_id = ? AND message_id = ?')
      .get(channelId, messageId);
  }

  TxEnqueueTurn(
    run: Run,
    queued: QueuedDispatch,
    message: TranscriptMessage,
    ingress?: { channelId: string; messageId: string },
    eventType = 'user_message'
  ): { duplicate: boolean; seq: number } {
    return this.db.transaction(() => {
      if (
        ingress &&
        this.db
          .prepare('SELECT 1 FROM processed_messages WHERE channel_id = ? AND message_id = ?')
          .get(ingress.channelId, ingress.messageId)
      ) {
        return { duplicate: true, seq: 0 };
      }
      const session = this.db
        .prepare('SELECT status,bound_worker_id FROM sessions WHERE id=?')
        .get(queued.sessionId) as { status: string; bound_worker_id: string | null } | undefined;
      if (
        !session ||
        session.status === 'closed' ||
        (session.bound_worker_id && session.bound_worker_id !== run.workerId)
      )
        throw conflict('Session changed while dispatching; retry the input');
      this.db
        .prepare(
          `INSERT INTO runs (id, work, attempt, worker_id, status, created_at, initiator_ids, merged_source_ids, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.id,
          JSON.stringify(run.work),
          run.attempt,
          run.workerId ?? null,
          run.status,
          run.createdAt,
          JSON.stringify(run.initiatorIds ?? []),
          JSON.stringify(run.mergedSourceIds ?? []),
          run.leaseExpiresAt ?? null
        );
      const { seq } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?')
        .get(queued.sessionId) as { seq: number };
      this.db
        .prepare(
          'INSERT INTO session_events (session_id, seq, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)'
        )
        .run(queued.sessionId, seq, eventType, JSON.stringify(message), message.timestamp);
      this.db
        .prepare(
          'INSERT INTO dispatch_queue (id, session_id, envelope, queued_at) VALUES (?, ?, ?, ?)'
        )
        .run(
          queued.id,
          queued.sessionId,
          JSON.stringify({ ...queued.envelope, snapshotBeforeSeq: seq }),
          queued.queuedAt
        );
      this.db
        .prepare('UPDATE sessions SET last_active_at=? WHERE id=?')
        .run(message.timestamp, queued.sessionId);
      if (ingress)
        this.db
          .prepare(
            'INSERT INTO processed_messages (channel_id, message_id, processed_at) VALUES (?, ?, ?)'
          )
          .run(ingress.channelId, ingress.messageId, message.timestamp);
      return { duplicate: false, seq };
    })();
  }
}
