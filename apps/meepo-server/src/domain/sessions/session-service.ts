import { randomUUID } from 'node:crypto';

import type { Session, SessionKind } from '@meepo/core';

import { notFound, validation } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { SessionRepository } from './session-repository.js';

export interface OpenSessionInput {
  spaceId: string;
  chatId: string;
  threadId: string;
  kind?: SessionKind;
}

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository
  ) {}

  /** Returns the live session bound to a Feishu window, creating one on first touch. */
  async getOrCreateByThread(input: OpenSessionInput): Promise<Session> {
    const space = await this.spaces.getById(input.spaceId);
    if (!space) throw validation(`Unknown space: ${input.spaceId}`);
    const existing = await this.sessions.getByThread(input.spaceId, input.chatId, input.threadId);
    if (existing && existing.status !== 'closed') return existing;
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      spaceId: input.spaceId,
      kind: input.kind ?? 'task',
      chatId: input.chatId,
      threadId: input.threadId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
    };
    await this.sessions.save(session);
    return session;
  }

  async getSession(id: string): Promise<Session> {
    const session = await this.sessions.getById(id);
    if (!session) throw notFound(`Session not found: ${id}`);
    return session;
  }

  async listBySpace(spaceId: string): Promise<Session[]> {
    return this.sessions.listBySpace(spaceId);
  }

  /** Pins the session to a worker; the binding is permanent unless the user rebinds. */
  async bindWorker(id: string, workerId: string): Promise<Session> {
    const session = await this.getSession(id);
    session.boundWorkerId = workerId;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session);
    return session;
  }

  async touch(id: string): Promise<Session> {
    const session = await this.getSession(id);
    session.lastActiveAt = Date.now();
    if (session.status === 'idle') session.status = 'active';
    await this.sessions.save(session);
    return session;
  }

  async close(id: string): Promise<Session> {
    const session = await this.getSession(id);
    session.status = 'closed';
    session.boundWorkerId = undefined;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session);
    return session;
  }
}
