import type { CompactionRepository } from './compaction-repository.js';
import type { CompactionSnapshot } from '@meepo/protocol';
import type { SessionSnapshot, TranscriptMessage, CanonicalEvent } from '@meepo/protocol';

import { notFound, validation } from '../errors.js';
import type { SessionEventRepository } from './session-event-repository.js';
import type { SessionRepository } from './session-repository.js';

export const MESSAGE_EVENT_TYPE = 'message';

/**
 * Owns the authoritative session transcript: appends turn messages to the
 * session event stream and builds rehydration snapshots from it.
 */
export class TranscriptService {
  constructor(
    private readonly events: SessionEventRepository,
    private readonly sessions: SessionRepository,
    private readonly compactions?: CompactionRepository
  ) {}

  async appendMessage(sessionId: string, message: TranscriptMessage): Promise<void> {
    await this.events.append(sessionId, MESSAGE_EVENT_TYPE, message, message.timestamp);
  }

  async getSnapshot(
    sessionId: string,
    beforeTimestamp?: number,
    beforeSeq?: number,
    options: { useCompaction?: boolean; afterSeq?: number } = {}
  ): Promise<SessionSnapshot> {
    const session = await this.sessions.getById(sessionId);
    if (!session) throw notFound(`Session not found: ${sessionId}`);
    for (const value of [beforeSeq, options.afterSeq]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw validation('Invalid snapshot cursor');
    }
    // A timestamp-only historical request cannot safely reuse a sequence cache.
    const usableCompaction =
      options.useCompaction && (beforeSeq !== undefined || beforeTimestamp === undefined)
        ? this.compactions?.latest(sessionId, beforeSeq ?? Number.MAX_SAFE_INTEGER)
        : undefined;
    const rows = await this.events.listBySession(sessionId, {
      beforeSeq,
      beforeTimestamp,
      includeHistoryNotes: true,
      afterSeq: Math.max(options.afterSeq ?? 0, usableCompaction?.coversThroughSeq ?? 0),
      limit: options.useCompaction ? 51 : undefined,
    });
    const events = options.useCompaction ? rows.slice(0, 50) : rows;
    const selected = events.filter(
      (e) =>
        (beforeSeq === undefined ||
          e.seq < beforeSeq ||
          (e.type === 'system_note' &&
            (e.payload as { historyOnly?: boolean }).historyOnly === true)) &&
        (beforeSeq !== undefined || beforeTimestamp === undefined || e.timestamp < beforeTimestamp)
    );
    const messages = selected
      .filter((event) =>
        [MESSAGE_EVENT_TYPE, 'user_message', 'system_note', 'assistant_text'].includes(event.type)
      )
      .map((event) =>
        event.type === MESSAGE_EVENT_TYPE || event.type === 'user_message'
          ? (event.payload as TranscriptMessage)
          : ({
              role: event.type === 'assistant_text' ? 'assistant' : 'user',
              content: (event.payload as { content: string }).content,
              timestamp: event.timestamp,
            } as TranscriptMessage)
      )
      .filter(
        (message) =>
          beforeSeq !== undefined ||
          beforeTimestamp === undefined ||
          message.timestamp < beforeTimestamp
      );
    return {
      sessionId,
      compaction: usableCompaction,
      hasMore: options.useCompaction ? rows.length > 50 : false,
      version: await this.events.latestSeq(sessionId),
      messages,
      events: selected as CanonicalEvent[],
    };
  }

  async recordCompaction(sessionId: string, snapshot: CompactionSnapshot, degraded = false) {
    if (!this.compactions) throw validation('Compaction storage unavailable');
    if (
      typeof snapshot.summary !== 'string' ||
      !snapshot.summary.trim() ||
      new TextEncoder().encode(snapshot.summary).length > 32768 ||
      !Number.isSafeInteger(snapshot.coversThroughSeq) ||
      snapshot.coversThroughSeq < 1 ||
      snapshot.coversThroughSeq > (await this.events.latestSeq(sessionId))
    )
      throw validation('Invalid compaction boundary or summary');
    this.compactions.TxSave(sessionId, snapshot, degraded);
  }

  async firstEvent(sessionId: string, type: string) {
    return (await this.events.listBySession(sessionId, { type, limit: 1 }))[0];
  }

  async appendEvent(sessionId: string, type: string, payload: unknown): Promise<CanonicalEvent> {
    return this.events.append(sessionId, type, payload);
  }

  async listEvents(sessionId: string, afterSeq = 0): Promise<CanonicalEvent[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw validation('Invalid event cursor');
    return this.events.listBySession(sessionId, { afterSeq, limit: 500 });
  }
}
