import type { SessionSnapshot, TranscriptMessage, CanonicalEvent } from '@meepo/protocol';

import { notFound } from '../errors.js';
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
    private readonly sessions: SessionRepository
  ) {}

  async appendMessage(sessionId: string, message: TranscriptMessage): Promise<void> {
    await this.events.append(sessionId, MESSAGE_EVENT_TYPE, message, message.timestamp);
  }

  async getSnapshot(
    sessionId: string,
    beforeTimestamp?: number,
    beforeSeq?: number
  ): Promise<SessionSnapshot> {
    const session = await this.sessions.getById(sessionId);
    if (!session) throw notFound(`Session not found: ${sessionId}`);
    const events = await this.events.listBySession(sessionId);
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
      version: events.at(-1)?.seq ?? 0,
      messages,
      events: selected as CanonicalEvent[],
    };
  }

  async appendEvent(sessionId: string, type: string, payload: unknown): Promise<CanonicalEvent> {
    return this.events.append(sessionId, type, payload);
  }

  async listEvents(sessionId: string, afterSeq = 0): Promise<CanonicalEvent[]> {
    return (await this.events.listBySession(sessionId)).filter((e) => e.seq > afterSeq);
  }
}
