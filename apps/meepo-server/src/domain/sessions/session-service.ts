import type { SessionClosingPort } from './session-lifecycle.js';
import { randomUUID } from 'node:crypto';

import type { Session, SessionKind } from '@meepo/core';

import { notFound, validation } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { SessionRepository } from './session-repository.js';

export interface OpenSessionInput {
  channelId?: string;
  spaceId: string;
  chatId: string;
  threadId: string;
  kind?: SessionKind;
  anchorMessageId?: string;
  prewarmMessageId?: string;
}

export class SessionService {
  private readonly opening = new Map<string, Promise<Session>>();
  constructor(
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository,
    private readonly closing?: SessionClosingPort
  ) {}

  /** Returns the live session bound to a Feishu window, creating one on first touch. */
  getOrCreateByThread(input: OpenSessionInput): Promise<Session> {
    const key = JSON.stringify([input.spaceId, input.channelId, input.chatId, input.threadId]);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const created = this.openSession(input).finally(() => this.opening.delete(key));
    this.opening.set(key, created);
    return created;
  }

  private async openSession(input: OpenSessionInput): Promise<Session> {
    const space = await this.spaces.getById(input.spaceId);
    if (!space) throw validation(`Unknown space: ${input.spaceId}`);
    const existing = await this.sessions.getByThread(
      input.spaceId,
      input.chatId,
      input.threadId,
      input.channelId
    );
    if (existing && existing.status !== 'closed') {
      if (input.anchorMessageId && !existing.anchorMessageId) {
        const expected = { ...existing };
        existing.anchorMessageId = input.anchorMessageId;
        await this.sessions.save(existing, expected);
      }
      return existing;
    }
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      channelId: input.channelId,
      windowId: `${input.channelId ?? 'feishu'}:${input.chatId}:${input.threadId}`,
      spaceId: input.spaceId,
      kind: input.kind ?? 'thread',
      chatId: input.chatId,
      threadId: input.threadId,
      anchorMessageId: input.anchorMessageId,
      prewarmMessageId: input.prewarmMessageId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
    };
    await this.sessions.save(session);
    return session;
  }

  /** Returns the live session bound to a thread, if one exists. */
  async findByThread(
    spaceId: string,
    chatId: string,
    threadId: string,
    channelId?: string
  ): Promise<Session | undefined> {
    const session = await this.sessions.getByThread(spaceId, chatId, threadId, channelId);
    return session && session.status !== 'closed' ? session : undefined;
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
    const expected = { ...session };
    session.boundWorkerId = workerId;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session, expected);
    return session;
  }

  async touch(id: string): Promise<Session> {
    const session = await this.getSession(id);
    const expected = { ...session };
    session.lastActiveAt = Date.now();
    if (session.status === 'idle') session.status = 'active';
    await this.sessions.save(session, expected);
    return session;
  }

  /** Backfills the reply anchor for sessions created before anchors existed. */
  async ensureAnchor(id: string, anchorMessageId: string): Promise<Session> {
    const session = await this.getSession(id);
    const expected = { ...session };
    if (!session.anchorMessageId) {
      session.anchorMessageId = anchorMessageId;
      await this.sessions.save(session, expected);
    }
    return session;
  }

  async reset(
    id: string,
    anchorMessageId: string,
    ingress: { channelId: string; messageId: string }
  ): Promise<Session | undefined> {
    return (await this.closing?.reset?.(id, anchorMessageId, ingress))?.session;
  }
  async close(id: string): Promise<Session> {
    if (this.closing) return this.closing.close(id);
    const session = await this.getSession(id);
    const expected = { ...session };
    session.status = 'closed';
    session.boundWorkerId = undefined;
    session.lastActiveAt = Date.now();
    await this.sessions.save(session, expected);
    return session;
  }
}
