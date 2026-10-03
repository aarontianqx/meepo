import type { CompactionSnapshot } from '@meepo/protocol';
export interface CompactionRepository {
  latest(sessionId: string, beforeSeq: number): CompactionSnapshot | undefined;
  TxSave(sessionId: string, snapshot: CompactionSnapshot, degraded: boolean): void;
}
