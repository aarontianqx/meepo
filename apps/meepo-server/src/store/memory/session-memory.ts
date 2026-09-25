import type { Session } from '@meepo/core';

import type { SessionRepository } from '../../domain/sessions/session-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemorySessionRepository extends MemoryTable<Session> implements SessionRepository {
  async getByThread(
    spaceId: string,
    chatId: string,
    threadId: string
  ): Promise<Session | undefined> {
    const all = await this.list();
    return all.find(
      (row) => row.spaceId === spaceId && row.chatId === chatId && row.threadId === threadId
    );
  }

  async listBySpace(spaceId: string): Promise<Session[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }
}
