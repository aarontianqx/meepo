import type { TurnDispatchEnvelope } from '@meepo/protocol';

export interface QueuedDispatch {
  id: string;
  sessionId: string;
  envelope: Omit<TurnDispatchEnvelope, 'model'>;
  queuedAt: number;
}

export interface DispatchQueueRepository {
  delete(id: string): Promise<void>;
  enqueue(item: QueuedDispatch): Promise<void>;
  listBySession(sessionId: string): Promise<QueuedDispatch[]>;
  deleteBySession(sessionId: string): Promise<void>;
  listSessionIds(): Promise<string[]>;
}
