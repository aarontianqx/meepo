import { describe, expect, it, vi } from 'vitest';
import type { CanonicalEvent, CompactionSnapshot, SessionSnapshot } from '@meepo/protocol';
import { loadDurableHistory, safePrefixLength } from '../durable-history.js';
import { historyText, summarizeInChunks } from '../compaction.js';
const event = (seq: number): CanonicalEvent => ({
  seq,
  type: 'user_message',
  payload: { role: 'user', content: `m${seq} ${'中'.repeat(30)}`, timestamp: seq },
  timestamp: seq,
});
describe('durable history compaction', () => {
  it('pages a long cold history, caches its exact prefix and avoids resummarizing it after restart', async () => {
    const raw = Array.from({ length: 180 }, (_, i) => event(i + 1));
    let cache: CompactionSnapshot | undefined;
    const summarize = vi.fn().mockResolvedValue('historical summary');
    const fetch = vi.fn(async (afterSeq = 0): Promise<SessionSnapshot> => {
      const rows = raw.filter((e) => e.seq > Math.max(afterSeq, cache?.coversThroughSeq ?? 0));
      return {
        sessionId: 's',
        version: 180,
        messages: [],
        events: rows.slice(0, 50),
        hasMore: rows.length > 50,
        compaction: cache,
      };
    });
    const record = vi.fn(async (c: CompactionSnapshot) => {
      cache = c;
    });
    const first = await loadDurableHistory({ fetch, record, summarize, maxBytes: 1000 });
    expect(cache!.coversThroughSeq).toBe(140);
    expect(first.events?.slice(1).map((e) => e.seq)).toEqual(raw.slice(140).map((e) => e.seq));
    expect(raw).toHaveLength(180);
    summarize.mockClear();
    fetch.mockClear();
    const second = await loadDurableHistory({ fetch, record, summarize, maxBytes: 1000 });
    expect(summarize).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.events).toEqual(first.events);
  });
  it('records and exposes a degraded summary when the provider fails', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const result = await loadDurableHistory({
      fetch: async () => ({
        sessionId: 's',
        version: 60,
        messages: [],
        events: Array.from({ length: 60 }, (_, i) => event(i + 1)),
      }),
      record,
      summarize: async () => {
        throw new Error('provider context limit');
      },
      maxBytes: 1000,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        coversThroughSeq: 20,
        summary: expect.stringContaining('上下文已截断'),
      }),
      true
    );
    expect(JSON.stringify(result.events?.[0])).toContain('上下文已截断');
    expect(result.events).toHaveLength(41);
  });
  it('moves the prefix boundary until no tool pair crosses it', () => {
    const events = Array.from({ length: 10 }, (_, i) => event(i + 1));
    events[1] = { ...events[1], type: 'tool_call', payload: { toolCallId: 'a' } };
    events[3] = { ...events[3], type: 'tool_call', payload: { toolCallId: 'b' } };
    events[4] = { ...events[4], type: 'tool_result', payload: { toolCallId: 'a' } };
    events[8] = { ...events[8], type: 'tool_result', payload: { toolCallId: 'b' } };
    expect(safePrefixLength(events, 4)).toBe(1);
  });
  it('keeps each summary input bounded and carries the previous summary into the next chunk', async () => {
    const calls: { bytes: number; previous: string }[] = [];
    const chunks: string[] = [];
    expect(
      historyText({ data: 'important fact', image: { type: 'image', data: 'binary' } })
    ).toContain('important fact');
    expect(historyText({ type: 'image', data: 'test-bytes' })).not.toContain('test-bytes');
    const result = await summarizeInChunks('中文'.repeat(2000), 1024, async (chunk, previous) => {
      chunks.push(chunk);
      calls.push({ bytes: Buffer.byteLength(chunk), previous });
      return 'summary';
    });
    expect(chunks.join('')).toBe('中文'.repeat(2000));
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.bytes <= 1024)).toBe(true);
    expect(calls[0].previous).toBe('');
    expect(calls[1].previous).toBe('summary');
    expect(result).toBe('summary');
  });
  it('does not turn cancellation into a successful history recovery', async () => {
    const fetch = vi.fn();
    await expect(
      loadDurableHistory({
        fetch,
        record: vi.fn(),
        summarize: vi.fn(),
        checkpoint: async () => {
          throw new Error('cancelled');
        },
      })
    ).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('waits for a delayed tool result across pages and compacts the complete pair', async () => {
    const raw = Array.from({ length: 150 }, (_, i) => event(i + 1));
    raw[0] = { ...raw[0], type: 'tool_call', payload: { toolCallId: 'late' } };
    raw[70] = {
      ...raw[70],
      type: 'tool_result',
      payload: { toolCallId: 'late', result: 'completed' },
    };
    const record = vi.fn();
    const summarize = vi.fn().mockResolvedValue('summary');
    await loadDurableHistory({
      fetch: async (afterSeq = 0) => ({
        sessionId: 's',
        version: 150,
        messages: [],
        events: raw.slice(afterSeq, afterSeq + 50),
        hasMore: afterSeq + 50 < 150,
      }),
      record,
      summarize,
      maxBytes: 1000,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ summary: 'summary', coversThroughSeq: 110 }, false);
    expect(summarize.mock.calls[0][0]).toContain('completed');
  });
  it.each(['bytes', 'events'] as const)(
    'fails explicitly at the %s boundary when an open tool prevents compaction',
    async (boundary) => {
      const raw = Array.from({ length: 150 }, (_, i) => event(i + 1));
      raw[0] = { ...raw[0], type: 'tool_call', payload: { toolCallId: 'unresolved' } };
      const record = vi.fn(),
        summarize = vi.fn();
      await expect(
        loadDurableHistory({
          fetch: async (afterSeq = 0) => ({
            sessionId: 's',
            version: 150,
            messages: [],
            events: raw.slice(afterSeq, afterSeq + 50),
            hasMore: afterSeq + 50 < 150,
          }),
          record,
          summarize,
          maxBytes: 1000,
          ...(boundary === 'bytes' ? { maxBufferedBytes: 15000 } : { maxBufferedEvents: 75 }),
        })
      ).rejects.toThrow('历史恢复超过安全缓冲上限');
      expect(record).not.toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(raw).toHaveLength(150);
      expect(raw.some((e) => e.type === 'tool_result')).toBe(false);
    }
  );
  it('rejects a single oversized event instead of silently dropping it', async () => {
    const record = vi.fn(),
      summarize = vi.fn();
    await expect(
      loadDurableHistory({
        fetch: async () => ({ sessionId: 's', version: 1, messages: [], events: [event(1)] }),
        record,
        summarize,
        maxBufferedBytes: 100,
      })
    ).rejects.toThrow('原始历史未删除');
    expect(record).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });
});
