import type { CanonicalEvent } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { argsSummary, buildTimeline, resultText } from './model';

const event = (
  seq: number,
  type: string,
  payload: unknown,
  timestamp = seq * 1000
): CanonicalEvent => ({
  seq,
  type,
  payload,
  timestamp,
});

describe('buildTimeline', () => {
  it('maps user and assistant messages in event order', () => {
    const items = buildTimeline([
      event(1, 'user_message', { role: 'user', content: 'hi', author: 'Mia', images: [{}, {}] }),
      event(2, 'message', { role: 'assistant', content: 'hello' }),
      event(3, 'message', { role: 'tool', content: 'hidden' }),
    ]);
    expect(items).toMatchObject([
      { kind: 'user', author: 'Mia', content: 'hi', imageCount: 2 },
      { kind: 'assistant', content: 'hello' },
    ]);
  });

  it('pairs a tool result with its call and measures duration', () => {
    const items = buildTimeline([
      event(1, 'tool_call', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }, 1000),
      event(2, 'tool_result', { toolCallId: 'c1', result: 'ok', isError: false }, 3500),
      event(3, 'tool_call', { toolCallId: 'c2', toolName: 'bash', args: {} }, 4000),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      tool: { name: 'bash', result: { text: 'ok', isError: false }, durationMs: 2500 },
    });
    expect(items[1]).toMatchObject({ kind: 'tool', tool: { callId: 'c2' } });
    expect(items[1].kind === 'tool' && items[1].tool.result).toBeUndefined();
  });

  it('ignores a tool result without a matching call', () => {
    expect(buildTimeline([event(1, 'tool_result', { toolCallId: 'ghost', result: 'x' })])).toEqual(
      []
    );
  });

  it('splits console notes into sender and content', () => {
    const items = buildTimeline([
      event(1, 'system_note', { content: '[Console message from Alice]\nplease retry' }),
      event(2, 'system_note', { content: 'plain note' }),
    ]);
    expect(items).toMatchObject([
      { kind: 'note', from: 'Alice', content: 'please retry' },
      { kind: 'note', content: 'plain note' },
    ]);
  });

  it('shows the base prompt once and reports run outcomes', () => {
    const items = buildTimeline([
      event(1, 'prompt_identity', { base: 'You are Meepo.' }),
      event(2, 'prompt_snapshot', { base: 'You are Meepo.' }),
      event(3, 'run_started', {}),
      event(4, 'run_failed', { error: 'boom' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['setup', 'run', 'run']);
    expect(items[2]).toMatchObject({ outcome: 'failed', text: 'boom' });
  });
});

describe('buildTimeline quotes and call ids', () => {
  it('lifts a quoted parent out of the user text', () => {
    const content = `<quoted_message>\n${JSON.stringify({ sender: 'ou_1', body: 'earlier' })}\n</quoted_message>\nwhat about now?`;
    const [item] = buildTimeline([event(1, 'user_message', { role: 'user', content })]);
    expect(item).toMatchObject({
      kind: 'user',
      content: 'what about now?',
      quote: { sender: 'ou_1', body: 'earlier' },
    });
  });

  it('leaves malformed quote markup as plain text', () => {
    const content = '<quoted_message>\nnot json\n</quoted_message>\nhi';
    const [item] = buildTimeline([event(1, 'user_message', { role: 'user', content })]);
    expect(item).toMatchObject({ content, quote: undefined });
  });

  it('pairs results within their own run when call ids repeat across runs', () => {
    const withRun = (e: CanonicalEvent, runId: string): CanonicalEvent => ({ ...e, runId });
    const items = buildTimeline([
      withRun(event(1, 'tool_call', { toolCallId: 'call_0', toolName: 'a', args: {} }), 'r1'),
      withRun(event(2, 'tool_result', { toolCallId: 'call_0', result: 'one' }), 'r1'),
      withRun(event(3, 'tool_call', { toolCallId: 'call_0', toolName: 'b', args: {} }), 'r2'),
      withRun(event(4, 'tool_result', { toolCallId: 'call_0', result: 'two' }), 'r2'),
    ]);
    expect(items.map((i) => (i.kind === 'tool' ? i.tool.result?.text : undefined))).toEqual([
      'one',
      'two',
    ]);
  });
});

describe('resultText', () => {
  it('joins text parts, marks other parts, and falls back to JSON', () => {
    expect(resultText('plain')).toBe('plain');
    expect(
      resultText({
        content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
      })
    ).toBe('a\n[image]\nb');
    expect(resultText({ n: 1 })).toBe('{\n  "n": 1\n}');
    expect(resultText(undefined)).toBe('');
  });
});

describe('argsSummary', () => {
  it('prefers well-known keys, then any string, then compact JSON', () => {
    expect(argsSummary({ other: 'x', command: 'git   status\n' })).toBe('git status');
    expect(argsSummary({ foo: 'bar' })).toBe('bar');
    expect(argsSummary({ n: 1 })).toBe('{"n":1}');
    expect(argsSummary({})).toBe('');
    expect(argsSummary(undefined)).toBe('');
  });
});
