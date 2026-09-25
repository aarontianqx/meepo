import type { Session } from '@meepo/core';

export interface SessionRepository {
  save(session: Session): Promise<void>;
  getById(id: string): Promise<Session | undefined>;
  getByThread(spaceId: string, chatId: string, threadId: string): Promise<Session | undefined>;
  listBySpace(spaceId: string): Promise<Session[]>;
}
