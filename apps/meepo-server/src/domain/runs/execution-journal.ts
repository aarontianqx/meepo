import type { Run, Ticket } from '@meepo/core';
import type { CanonicalEvent, SequencedWorkerEvent, StreamAck } from '@meepo/protocol';

/** Atomic durable boundary for worker events and their run projection. */
export interface ExecutionJournal {
  TxInterrupt(runId: string, reason: string, now: number): Run | undefined;
  TxRenew(workerId: string, runIds: string[], durationMs: number, now: number): void;
  TxExpire(run: Run, ticket?: Ticket): boolean;
  TxAppend(workerId: string, event: SequencedWorkerEvent, now: number): StreamAck;
  listByRun(runId: string): CanonicalEvent[];
}
