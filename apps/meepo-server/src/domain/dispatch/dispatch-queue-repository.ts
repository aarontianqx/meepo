import type { SessionDispatchEnvelope } from '@meepo/protocol';

export interface QueuedDispatch {
  id: string;
  sessionId: string;
  envelope: SessionDispatchEnvelope;
  queuedAt: number;
}

export interface DispatchQueueRepository {
  enqueue(item: QueuedDispatch): Promise<void>;
  listBySession(sessionId: string): Promise<QueuedDispatch[]>;
  deleteBySession(sessionId: string): Promise<void>;
  listSessionIds(): Promise<string[]>;
}
