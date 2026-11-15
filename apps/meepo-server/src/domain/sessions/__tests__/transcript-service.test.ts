import { beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '@meepo/core';

import { TranscriptService } from '../transcript-service.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';

function makeSession(id: string): Session {
  return {
    id,
    spaceId: 'sp1',
    kind: 'main',
    chatId: 'chat',
    threadId: 'thread',
    status: 'active',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

describe('TranscriptService', () => {
  let events: MemorySessionEventRepository;
  let service: TranscriptService;

  beforeEach(async () => {
    events = new MemorySessionEventRepository();
    service = new TranscriptService(events, new MemorySessionRepository());
    await new MemorySessionRepository().save(makeSession('se1'));
    const sessions = new MemorySessionRepository();
    await sessions.save(makeSession('se1'));
    service = new TranscriptService(events, sessions);
  });

  describe('lastTurnSentAt', () => {
    const turn = (sentAt?: number) => ({ role: 'user', content: 'x', timestamp: 1, sentAt });

    it('returns the send time of the newest chat-triggered turn', async () => {
      await service.appendEvent('se1', 'user_message', turn(100));
      await service.appendEvent('se1', 'user_message', turn(200));
      expect(await service.lastTurnSentAt('se1')).toBe(200);
    });

    it('skips newer turns that carry no send time, and ignores other event types', async () => {
      await service.appendEvent('se1', 'user_message', turn(100));
      await service.appendEvent('se1', 'user_message', turn());
      await service.appendEvent('se1', 'message', turn(900));
      expect(await service.lastTurnSentAt('se1')).toBe(100);
    });

    it('is undefined when no turn recorded one', async () => {
      expect(await service.lastTurnSentAt('se1')).toBeUndefined();
      await service.appendEvent('se1', 'user_message', turn());
      expect(await service.lastTurnSentAt('se1')).toBeUndefined();
    });
  });

  it('reports the latest event sequence and returns appended records', async () => {
    expect(await service.latestSeq('se1')).toBe(0);
    const record = await service.appendMessage('se1', { role: 'user', content: 'a', timestamp: 1 });
    expect(record.seq).toBe(1);
    expect(await service.latestSeq('se1')).toBe(1);
  });

  it('excludes messages at or after beforeTimestamp', async () => {
    await service.appendMessage('se1', { role: 'user', content: 'first', timestamp: 1000 });
    await service.appendMessage('se1', { role: 'user', content: 'current turn', timestamp: 2000 });

    const full = await service.getSnapshot('se1');
    expect(full.messages).toHaveLength(2);

    const deduped = await service.getSnapshot('se1', 2000);
    expect(deduped.messages).toHaveLength(1);
    expect(deduped.messages[0].content).toBe('first');
  });
});
