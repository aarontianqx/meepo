import { conflict } from '../../domain/errors.js';
import type { Session } from '@meepo/core';

import type { SessionRepository } from '../../domain/sessions/session-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemorySessionRepository extends MemoryTable<Session> implements SessionRepository {
  override async save(
    session: Session,
    expected?: Pick<Session, 'status' | 'boundWorkerId'>
  ): Promise<void> {
    const old = await this.getById(session.id);
    if (
      (old?.status === 'closed' && session.status !== 'closed') ||
      (expected &&
        (!old || old.status !== expected.status || old.boundWorkerId !== expected.boundWorkerId))
    )
      throw conflict('Session changed; retry the operation');
    await super.save(session);
  }
  async getByThread(
    spaceId: string,
    chatId: string,
    threadId: string,
    channelId?: string
  ): Promise<Session | undefined> {
    const all = await this.list();
    return all.find(
      (row) =>
        row.spaceId === spaceId &&
        row.chatId === chatId &&
        row.threadId === threadId &&
        row.channelId === channelId &&
        row.status !== 'closed'
    );
  }

  async listBySpace(spaceId: string): Promise<Session[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceId === spaceId);
  }
}
