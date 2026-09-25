import type { SessionEventRecord } from '../../domain/sessions/session-event-repository.js';
import type { SessionEventRepository } from '../../domain/sessions/session-event-repository.js';

export class MemorySessionEventRepository implements SessionEventRepository {
  private readonly rows = new Map<string, SessionEventRecord[]>();

  async append(
    sessionId: string,
    type: string,
    payload: unknown,
    timestamp: number = Date.now()
  ): Promise<SessionEventRecord> {
    const events = this.rows.get(sessionId) ?? [];
    const record: SessionEventRecord = {
      sessionId,
      seq: events.length + 1,
      type,
      payload: structuredClone(payload),
      timestamp,
    };
    events.push(record);
    this.rows.set(sessionId, events);
    return structuredClone(record);
  }

  async listBySession(sessionId: string): Promise<SessionEventRecord[]> {
    return (this.rows.get(sessionId) ?? []).map((row) => structuredClone(row));
  }

  async latestSeq(sessionId: string): Promise<number> {
    return this.rows.get(sessionId)?.length ?? 0;
  }
}
