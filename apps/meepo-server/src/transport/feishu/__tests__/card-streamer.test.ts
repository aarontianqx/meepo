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

  describe('failure and pagination presentation', () => {
    /** Final JSON of each card, in creation order. */
    function finalCards(
      client: FakeFeishuClient
    ): { body: { elements: Record<string, unknown>[] } }[] {
      return client.createdCards.map((created, index) => {
        const update = client.cardUpdates.filter((u) => u.cardId === `card_${index + 1}`).at(-1);
        return JSON.parse(update?.cardJson ?? created) as {
          body: { elements: Record<string, unknown>[] };
        };
      });
    }

    /** Body text of a card: the streamed markdown element, without pills or footer. */
    function markdownOf(card: { body: { elements: Record<string, unknown>[] } }): string {
      return card.body.elements
        .filter((e) => e.element_id === 'md')
        .map((e) => String(e.content))
        .join('\n');
    }

    async function failWith(
      error: string,
      code?: string
    ): Promise<{ client: FakeFeishuClient; card: string }> {
      const client = new FakeFeishuClient();
      const streamer = makeStreamer(client);
      streamer.handleEvent(started(), REF);
      streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'partial' }, REF);
      streamer.handleEvent({ type: 'run_failed', runId: 't1', error, code }, REF);
      await vi.advanceTimersByTimeAsync(0);
      return { client, card: finalCards(client).map(markdownOf).join('\n') };
    }

    it('shows a stop as a neutral line, not a failure', async () => {
      for (const code of ['stopped', 'aborted']) {
        const { card } = await failWith(code, code);
        expect(card).toContain('⏹ 已停止');
        expect(card).not.toContain('任务失败');
      }
    });

    it('explains a reset or rebind without echoing the internal code', async () => {
      const { card } = await failWith('session_changed', 'session_changed');
      expect(card).toContain('会话已被重置或换绑');
      expect(card).not.toContain('session_changed');
    });

    it('summarizes model errors instead of echoing provider payloads', async () => {
      const auth = await failWith('401 {"error":"Invalid API key sk-secret"}', 'error');
      expect(auth.card).toContain('认证失败');
      expect(auth.card).not.toContain('sk-secret');
      expect((await failWith('429 Too Many Requests', 'error')).card).toContain('额度');
      expect((await failWith('502 Bad Gateway', 'error')).card).toContain('暂时不可用');
      expect((await failWith('socket hang up', 'error')).card).toContain('模型调用失败');
    });

    it('renders a rebuilt model failure without the bare reason code', async () => {
      const client = new FakeFeishuClient();
      const projection = {
        runId: 't1',
        sessionId: 's1',
        channelId: 'ch',
        text: 'partial',
        thinking: '',
        tools: {},
        failure: 'error',
        sequence: 0,
        part: 0,
        offset: 0,
        state: 'failed' as const,
        dirty: true,
        updatedAt: 1,
      };
      const streamer = new CardStreamer({
        client,
        sessions: { getSession: async () => SESSION },
        channelId: 'ch',
        outbox: { get: () => projection, listPending: () => [projection], save: vi.fn() },
      });
      streamer.recover();
      await vi.advanceTimersByTimeAsync(0);
      const card = finalCards(client).map(markdownOf).join('\n');
      expect(card).toContain('模型调用失败');
      expect(card).not.toMatch(/任务失败：error/);
    });

    it('marks running tools as failed when the run fails', async () => {
      const client = new FakeFeishuClient();
      const streamer = makeStreamer(client);
      streamer.handleEvent(
        { type: 'tool_execution_start', runId: 't1', toolCallId: 'c', toolName: 'bash', args: {} },
        REF
      );
      streamer.handleEvent({ type: 'text_delta', runId: 't1', delta: 'x' }, REF);
      streamer.handleEvent({ type: 'run_failed', runId: 't1', error: 'boom' }, REF);
      await vi.advanceTimersByTimeAsync(0);
      const pills = JSON.stringify(finalCards(client)[0]);
      expect(pills).toContain('bash');
      expect(pills).not.toContain('⏳');
    });

    it('breaks pages at line ends and keeps code fences balanced', async () => {
      const client = new FakeFeishuClient();
      const streamer = makeStreamer(client);
      const code = 'const value = 1;\n'.repeat(2500);
      streamer.handleEvent({ type: 'thinking_delta', runId: 't1', delta: 'hmm' }, REF);
      streamer.handleEvent(
        { type: 'assistant_text', runId: 't1', content: `intro\n\`\`\`ts\n${code}\`\`\`\nend` },
        REF
      );
      streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
      await vi.advanceTimersByTimeAsync(0);

      const [first, second] = finalCards(client).map(markdownOf);
      expect(finalCards(client)).toHaveLength(2);
      expect(first.endsWith('\n```')).toBe(true);
      expect(first).not.toMatch(/const value = \d?$/m);
      expect(second.startsWith('```\n')).toBe(true);
      expect(second.endsWith('end')).toBe(true);
      const lines = (first + second).split('\n').filter((l) => l === 'const value = 1;');
      expect(lines).toHaveLength(2500);
    });

    it('shows thinking and tool pills on the first card only', async () => {
      const client = new FakeFeishuClient();
      const streamer = makeStreamer(client);
      streamer.handleEvent({ type: 'thinking_delta', runId: 't1', delta: 'pondering' }, REF);
      streamer.handleEvent(
        { type: 'tool_execution_start', runId: 't1', toolCallId: 'c', toolName: 'bash', args: {} },
        REF
      );
      streamer.handleEvent(
        { type: 'assistant_text', runId: 't1', content: 'A'.repeat(40000) },
        REF
      );
      streamer.handleEvent({ type: 'run_completed', runId: 't1' }, REF);
      await vi.advanceTimersByTimeAsync(0);
      const [first, second] = finalCards(client).map((c) => JSON.stringify(c));
      expect(first).toContain('pondering');
      expect(first).toContain('bash');
      expect(second).not.toContain('pondering');
      expect(second).not.toContain('bash');
    });
  });
});
