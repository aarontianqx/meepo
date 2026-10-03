import type { CanonicalEvent, CompactionSnapshot, SessionSnapshot } from '@meepo/protocol';
import { boundedText } from '@meepo/protocol';
import { historyText } from './compaction.js';

export interface DurableHistoryDeps {
  fetch(afterSeq?: number): Promise<SessionSnapshot>;
  record(snapshot: CompactionSnapshot, degraded: boolean): Promise<void>;
  summarize(text: string): Promise<string>;
  checkpoint?(): Promise<void>;
  maxBytes?: number;
  maxBufferedBytes?: number;
  maxBufferedEvents?: number;
}
const relevant = new Set([
  'message',
  'user_message',
  'system_note',
  'assistant_text',
  'tool_call',
  'tool_result',
]);
export function safePrefixLength(events: CanonicalEvent[], retain = 40): number {
  let cut = Math.max(0, events.length - retain);
  const calls = new Map<string, number>(),
    pairs: [number, number][] = [];
  const key = (e: CanonicalEvent) =>
    JSON.stringify([e.runId, (e.payload as { toolCallId?: string }).toolCallId]);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'tool_call') calls.set(key(e), i);
    if (e.type === 'tool_result') {
      const call = calls.get(key(e));
      if (call !== undefined) pairs.push([call, i]);
    }
  }
  // Results are ordered by position. A reverse pass handles nested/overlapping pairs
  // without rescanning all pairs for each movement of the cut.
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [call, result] = pairs[i];
    if (call < cut && result >= cut) cut = call;
  }
  return cut;
}
/** Summary is a cache of an exact canonical prefix. Raw events are never deleted. */
export async function loadDurableHistory(deps: DurableHistoryDeps): Promise<SessionSnapshot> {
  let afterSeq: number | undefined, cached: CompactionSnapshot | undefined;
  let events: CanonicalEvent[] = [];
  let sizes: number[] = [],
    bufferedBytes = 0;
  const maxBufferedBytes = deps.maxBufferedBytes ?? 4 * 1024 * 1024;
  const maxBufferedEvents = deps.maxBufferedEvents ?? 4096;
  let page: SessionSnapshot;
  do {
    await deps.checkpoint?.();
    page = await deps.fetch(afterSeq);
    if (!page.events) return page; // Historical test/provider snapshots.
    if (afterSeq === undefined) cached = page.compaction;
    const batch = page.events;
    const next = batch.at(-1)?.seq;
    if (page.hasMore && (next === undefined || next <= (afterSeq ?? 0)))
      throw new Error('Snapshot cursor did not advance');
    afterSeq = next ?? afterSeq;
    for (const event of batch) {
      if (!relevant.has(event.type)) continue;
      const size = Buffer.byteLength(historyText(event));
      if (bufferedBytes + size > maxBufferedBytes || events.length >= maxBufferedEvents)
        throw new Error(
          '历史恢复超过安全缓冲上限，无法保留完整上下文并安全切分工具记录。原始历史未删除；未确认的工具结果仍为未知，请在 Console 核实后开启新会话。'
        );
      events.push(event);
      sizes.push(size);
      bufferedBytes += size;
    }
    if (bufferedBytes <= (deps.maxBytes ?? 256 * 1024)) continue;
    const cut = safePrefixLength(events);
    if (cut > 0) {
      // A following page might contain a tool result: only compact through a closed pair.
      const prefix = events.slice(0, cut),
        tail = events.slice(cut);
      const open = new Set<string>();
      for (const e of prefix) {
        const key = JSON.stringify([e.runId, (e.payload as { toolCallId?: string }).toolCallId]);
        if (e.type === 'tool_call') open.add(key);
        if (e.type === 'tool_result') open.delete(key);
      }
      if (page.hasMore && open.size) continue;
      let summary: string,
        degraded = false;
      await deps.checkpoint?.();
      try {
        summary = await deps.summarize(
          historyText({ previousSummary: cached?.summary, events: prefix })
        );
      } catch {
        degraded = true;
        summary =
          '[上下文已截断：历史摘要生成失败；原始事件保留于 Console。以下仅为不完整摘录，不应假定遗漏部分的事实。]\n' +
          boundedText(historyText({ previousSummary: cached?.summary, events: prefix }), 8000);
      }
      const checkpoint = {
        summary: boundedText(summary, 16000),
        coversThroughSeq: prefix.at(-1)!.seq,
      };
      await deps.checkpoint?.();
      await deps.record(checkpoint, degraded);
      cached = checkpoint;
      for (let i = 0; i < cut; i++) bufferedBytes -= sizes[i];
      sizes = sizes.slice(cut);
      events = tail;
    }
  } while (page.hasMore);
  const note: CanonicalEvent[] = cached
    ? [
        {
          seq: cached.coversThroughSeq,
          type: 'system_note',
          payload: { content: `[Summary of earlier events]\n${cached.summary}` },
          timestamp: 0,
        },
      ]
    : [];
  return { ...page, compaction: cached, events: [...note, ...events], hasMore: false };
}
