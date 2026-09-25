import type { SessionSnapshot, TranscriptMessage } from '@meepo/protocol';

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

  async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.sessions.getById(sessionId);
    if (!session) throw notFound(`Session not found: ${sessionId}`);
    const events = await this.events.listBySession(sessionId);
    const messages = events
      .filter((event) => event.type === MESSAGE_EVENT_TYPE)
      .map((event) => event.payload as TranscriptMessage);
    return { sessionId, version: events.length, messages };
  }
}
