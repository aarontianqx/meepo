import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@meepo/core';
import type { WorkerStreamEvent } from '@meepo/protocol';

import { CardStreamer } from '../card-streamer.js';
import type { FeishuClient, ReplyResult } from '../feishu-client.js';

class FakeFeishuClient implements FeishuClient {
  readonly createdCards: string[] = [];
  readonly cardsSentTo: { messageId: string; cardId: string }[] = [];
  readonly contentUpdates: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
    uuid: string;
  }[] = [];
  readonly settingsUpdates: { cardId: string; settings: string; sequence: number }[] = [];
  private nextCard = 0;

  async replyText(): Promise<ReplyResult> {
    throw new Error('not used by the card streamer');
  }

  async replyCard(messageId: string, cardId: string): Promise<void> {
    this.cardsSentTo.push({ messageId, cardId });
  }

  async createCard(cardJson: string): Promise<string> {
    this.createdCards.push(cardJson);
    this.nextCard += 1;
    return `card_${this.nextCard}`;
  }

  async updateCardContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid: string
  ): Promise<void> {
    this.contentUpdates.push({ cardId, elementId, content, sequence, uuid });
  }

  async updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void> {
    this.settingsUpdates.push({ cardId, settings, sequence });
  }

  async listThreadMessages(): Promise<never[]> {
    return [];
  }
}

const SESSION: Session = {
  id: 's1',
  spaceId: 'sp1',
  kind: 'thread',
  chatId: 'oc_1',
  threadId: 'omt_1',
  anchorMessageId: 'om_root',
  status: 'active',
  createdAt: 0,
  lastActiveAt: 0,
};

const REF = { kind: 'session', sessionId: 's1' } as const;

function makeStreamer(client: FakeFeishuClient): CardStreamer {
  return new CardStreamer({
    client,
    sessions: { getSession: async () => SESSION },
    flushIntervalMs: 500,
  });
}

function started(runId = 't1'): WorkerStreamEvent {
  return { type: 'run_started', runId, workerId: 'w1', sessionId: 's1' };
}

describe('CardStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates a streaming card and sends it to the session thread on run_started', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createdCards).toHaveLength(1);
    const cardJson = JSON.parse(client.createdCards[0]) as {
      schema: string;
      config: { streaming_mode: boolean };
    };
    expect(cardJson.schema).toBe('2.0');
    expect(cardJson.config.streaming_mode).toBe(true);
    expect(client.cardsSentTo).toEqual([{ messageId: 'om_root', cardId: 'card_1' }]);
  });

  it('throttles deltas into full-text updates with increasing sequence', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);

    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'Hello ' }, REF);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'world' }, REF);
    await vi.advanceTimersByTimeAsync(499);
    expect(client.contentUpdates).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.contentUpdates).toEqual([
      {
        cardId: 'card_1',
        elementId: 'md',
        content: 'Hello world',
        sequence: 1,
        uuid: 'card_1_1',
      },
    ]);

    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: '!' }, REF);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.contentUpdates).toHaveLength(2);
    expect(client.contentUpdates[1]).toMatchObject({ content: 'Hello world!', sequence: 2 });
  });

  it('flushes and closes streaming mode on run_completed', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'done' }, REF);
    streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.contentUpdates).toHaveLength(1);
    expect(client.contentUpdates[0]).toMatchObject({ content: 'done', sequence: 1 });
    expect(client.settingsUpdates).toEqual([
      {
        cardId: 'card_1',
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence: 2,
      },
    ]);
  });

  it('appends a failure marker on run_failed before closing', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'partial' }, REF);
    streamer.handleEvent({ type: 'run_failed', runId: 't1', error: 'boom' }, REF);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.contentUpdates).toHaveLength(1);
    expect(client.contentUpdates[0].content).toContain('partial');
    expect(client.contentUpdates[0].content).toContain('⚠️');
    expect(client.contentUpdates[0].content).toContain('boom');
    expect(client.settingsUpdates).toHaveLength(1);
  });

  it('ignores ticket runs', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(
      { type: 'run_started', runId: 't1', workerId: 'w1', ticketId: 'tk1' },
      { kind: 'ticket', ticketId: 'tk1' }
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.createdCards).toHaveLength(0);
  });
});
