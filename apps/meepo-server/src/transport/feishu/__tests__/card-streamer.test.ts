import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@meepo/core';
import type { WorkerStreamEvent } from '@meepo/protocol';

import { CardStreamer } from '../card-streamer.js';
import type { FeishuClient, ReplyResult } from '../feishu-client.js';

class FakeFeishuClient implements FeishuClient {
  readonly createdCards: string[] = [];
  readonly cardsSentTo: { messageId: string; cardId: string }[] = [];
  readonly cardUpdates: { cardId: string; cardJson: string; sequence: number; uuid: string }[] = [];
  readonly settingsUpdates: { cardId: string; settings: string; sequence: number }[] = [];
  readonly deletedMessages: string[] = [];
  private nextCard = 0;

  async replyText(): Promise<ReplyResult> {
    throw new Error('not used by the card streamer');
  }

  async replyCard(messageId: string, cardId: string): Promise<void> {
    this.cardsSentTo.push({ messageId, cardId });
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.deletedMessages.push(messageId);
  }

  async createCard(cardJson: string): Promise<string> {
    this.createdCards.push(cardJson);
    this.nextCard += 1;
    return `card_${this.nextCard}`;
  }

  async updateCard(
    cardId: string,
    cardJson: string,
    sequence: number,
    uuid: string
  ): Promise<void> {
    this.cardUpdates.push({ cardId, cardJson, sequence, uuid });
  }

  async updateCardSettings(cardId: string, settings: string, sequence: number): Promise<void> {
    this.settingsUpdates.push({ cardId, settings, sequence });
  }

  async listThreadMessages(): Promise<never[]> {
    return [];
  }

  async getChatName(chatId: string): Promise<string> {
    return chatId;
  }
}

const SESSION: Session = {
  id: 's1',
  spaceId: 'sp1',
  kind: 'thread',
  chatId: 'oc_1',
  threadId: 'omt_1',
  anchorMessageId: 'om_root',
  prewarmMessageId: 'om_prewarm',
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

function lastCard(client: FakeFeishuClient): {
  body: { elements: Record<string, unknown>[] };
} {
  const raw = client.cardUpdates.at(-1)?.cardJson ?? client.createdCards.at(-1) ?? '{}';
  return JSON.parse(raw) as { body: { elements: Record<string, unknown>[] } };
}

describe('CardStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for content before replacing prewarm with a card and keeps runId on stop', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createdCards).toHaveLength(0);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'Hello' }, REF);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.deletedMessages).toEqual(['om_prewarm']);
    expect(client.createdCards).toHaveLength(1);
    const card = lastCard(client);
    const tags = card.body.elements.map((e) => e.tag);
    expect(tags).toEqual(['markdown', 'button']);
    expect(card.body.elements.at(-1)).toMatchObject({ value: { runId: 't1' } });
    expect(client.cardsSentTo).toEqual([{ messageId: 'om_root', cardId: 'card_1' }]);
  });

  it('throttles deltas into full-card updates with increasing sequence', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);

    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'Hello ' }, REF);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'world' }, REF);
    await vi.advanceTimersByTimeAsync(499);
    expect(client.cardUpdates).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.cardUpdates).toHaveLength(1);
    expect(client.cardUpdates[0].sequence).toBe(1);
    const card = lastCard(client);
    expect(card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'Hello world' });

    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: '!' }, REF);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.cardUpdates).toHaveLength(2);
    expect(client.cardUpdates[1].sequence).toBe(2);
    expect(lastCard(client).body.elements[0]).toMatchObject({ content: 'Hello world!' });
  });

  it('replaces partial deltas with canonical text and preserves repeated assistant messages', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'Hel' }, REF);
    streamer.handleEvent({ type: 'assistant_text', runId: 't1', content: 'Hello' }, REF);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'Hello' }, REF);
    streamer.handleEvent({ type: 'assistant_text', runId: 't1', content: 'Hello' }, REF);
    streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCard(client).body.elements.find((e) => e.tag === 'markdown')).toMatchObject({
      content: 'Hello\n\nHello',
    });
  });

  it('renders thinking deltas into a collapsible panel', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);
    streamer.handleEvent({ type: 'thinking_delta', runId: 't1', delta: 'hmm…' }, REF);
    await vi.advanceTimersByTimeAsync(500);

    const card = lastCard(client);
    const panel = card.body.elements.find((e) => e.tag === 'collapsible_panel');
    expect(panel).toBeDefined();
    expect(panel).toMatchObject({ expanded: false });
  });

  it('removes the button and closes streaming on run_completed', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'done' }, REF);
    streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
    await vi.advanceTimersByTimeAsync(0);

    const card = lastCard(client);
    const tags = card.body.elements.map((e) => e.tag);
    expect(tags).not.toContain('button');
    expect(client.settingsUpdates).toHaveLength(1);
  });

  it('appends a failure marker and removes the button on run_failed', async () => {
    const client = new FakeFeishuClient();
    const streamer = makeStreamer(client);

    streamer.handleEvent(started(), REF);
    await vi.advanceTimersByTimeAsync(0);
    streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'partial' }, REF);
    streamer.handleEvent({ type: 'run_failed', runId: 't1', error: 'boom' }, REF);
    await vi.advanceTimersByTimeAsync(0);

    const card = lastCard(client);
    const md = card.body.elements.find((e) => e.tag === 'markdown') as { content: string };
    expect(md.content).toContain('partial');
    expect(md.content).toContain('⚠️');
    expect(md.content).toContain('boom');
    expect(card.body.elements.map((e) => e.tag)).not.toContain('button');
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
  it('tools alone and machine failures remain silent', async () => {
    const client = new FakeFeishuClient();
    const streamer = new CardStreamer({
      client,
      sessions: { getSession: async () => SESSION },
      isUserRun: async () => false,
    });
    streamer.handleEvent(
      {
        type: 'tool_execution_start',
        runId: 'machine',
        toolCallId: 'c',
        toolName: 'bash',
        args: { secret: 'hidden' },
      },
      REF
    );
    await vi.advanceTimersByTimeAsync(500);
    streamer.handleEvent({ type: 'run_failed', runId: 'machine', error: 'failed' }, REF);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.createdCards).toEqual([]);
  });
  it('rotates long content in order and exposes tool names without arguments', async () => {
    const client = new FakeFeishuClient(),
      streamer = makeStreamer(client);
    streamer.handleEvent(
      {
        type: 'tool_execution_start',
        runId: 't1',
        toolCallId: 'c',
        toolName: 'bash',
        args: { secret: 'hidden' },
      },
      REF
    );
    streamer.handleEvent({ type: 'assistant_text', runId: 't1', content: 'A'.repeat(60001) }, REF);
    streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.cardsSentTo).toHaveLength(3);
    expect(client.settingsUpdates).toHaveLength(3);
    expect(client.createdCards.join('')).toContain('bash');
    expect(client.createdCards.join('')).not.toContain('hidden');
    expect(client.createdCards.join('')).not.toContain('abort_run');
    expect(client.cardUpdates.every((x) => x.sequence === 1)).toBe(true);
  });
  it('recovers a send whose response was lost by checking Feishu before retrying', async () => {
    const client = new FakeFeishuClient();
    const state = {
      runId: 't1',
      sessionId: 's1',
      channelId: 'ch',
      text: 'recovered',
      thinking: '',
      tools: {},
      cardId: 'existing',
      sendStartedAt: 10,
      sequence: 3,
      part: 0,
      offset: 0,
      state: 'completed' as const,
      dirty: true,
      updatedAt: 20,
    };
    const findReply = vi.fn(async () => ({ messageId: 'already-sent' }));
    const streamer = new CardStreamer({
      client: Object.assign(client, { findReply }),
      sessions: { getSession: async () => SESSION },
      channelId: 'ch',
      outbox: { get: () => state, listPending: () => [state], save: vi.fn() },
    });
    streamer.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReply).toHaveBeenCalled();
    expect(client.cardsSentTo).toEqual([]);
    expect(client.cardUpdates[0].sequence).toBe(4);
  });
});
