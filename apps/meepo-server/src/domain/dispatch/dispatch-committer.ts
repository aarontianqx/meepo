import type { Run, Ticket } from '@meepo/core';
import type { TranscriptMessage } from '@meepo/protocol';
import type { QueuedDispatch } from './dispatch-queue-repository.js';

export interface DispatchCommitter {
  TxClaimTicket(ticket: Ticket, run: Run, maxSlots: number): boolean;
  TxMergeQueue(
    items: QueuedDispatch[],
    envelope: QueuedDispatch['envelope'],
    workerId: string,
    leaseExpiresAt: number,
    now: number
  ): boolean;
  hasProcessedMessage(channelId: string, messageId: string): boolean;
  /** Atomically deduplicate ingress and persist the run, input and outbox. */
  TxEnqueueTurn(
    run: Run,
    queued: QueuedDispatch,
    message: TranscriptMessage,
    ingress?: { channelId: string; messageId: string },
    eventType?: string
  ): { duplicate: boolean; seq: number };
}
