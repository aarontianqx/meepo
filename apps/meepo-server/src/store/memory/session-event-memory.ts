import type {
  EventQuery,
  SessionEventRecord,
} from '../../domain/sessions/session-event-repository.js';
import type { SessionEventRepository } from '../../domain/sessions/session-event-repository.js';

export class MemorySessionEventRepository implements SessionEventRepository {
  private readonly rows = new Map<string, SessionEventRecord[]>();

  async hasImage(sessionId: string, messageId: string, fileKey: string): Promise<boolean> {
    return (this.rows.get(sessionId) ?? []).some(
      (e) =>
        ['message', 'user_message'].includes(e.type) &&
        (e.payload as { images?: { messageId: string; fileKey: string }[] }).images?.some(
          (i) => i.messageId === messageId && i.fileKey === fileKey
        )
    );
  }
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

  async listBySession(sessionId: string, query: EventQuery = {}): Promise<SessionEventRecord[]> {
    return (this.rows.get(sessionId) ?? [])
      .filter(
        (e) =>
          e.seq > (query.afterSeq ?? 0) &&
          (!query.type || e.type === query.type) &&
          (query.beforeSeq === undefined
            ? query.beforeTimestamp === undefined || e.timestamp < query.beforeTimestamp
            : e.seq < query.beforeSeq ||
              (query.includeHistoryNotes &&
                e.type === 'system_note' &&
                (e.payload as { historyOnly?: boolean }).historyOnly))
      )
      .slice(0, query.limit)
      .map((row) => structuredClone(row));
  }

  async latestSeq(sessionId: string): Promise<number> {
    return this.rows.get(sessionId)?.length ?? 0;
  }
}
