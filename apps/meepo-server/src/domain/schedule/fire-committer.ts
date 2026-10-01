import type { Run, Schedule, Ticket } from '@meepo/core';
import type { TranscriptMessage } from '@meepo/protocol';
import type { QueuedDispatch } from '../dispatch/dispatch-queue-repository.js';

export interface ScheduleWork {
  fireId: string;
  schedule: Schedule;
  expectedLastFiredAt?: number;
  ticket?: Ticket;
  turn?: { run: Run; queued: QueuedDispatch; message: TranscriptMessage };
}
export interface FireCommitter {
  TxFire(work: ScheduleWork): boolean;
}
