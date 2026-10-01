import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, ModelConfig } from '@meepo/protocol';
import { restoreEvents } from '../history.js';
import { keepRecentMessages } from '../session-runner.js';
import { SlotSemaphore } from '../slot-semaphore.js';
const model: ModelConfig = {
  provider: 'test',
  model: 'test',
  apiKey: 'unused',
  baseUrl: 'http://localhost',
};
const event = (seq: number, type: string, payload: unknown): CanonicalEvent => ({
  seq,
  type,
  payload,
  timestamp: seq,
});
describe('cold recovery and scheduling contracts', () => {
  it('preserves tool IDs, pairs parallel calls, and marks unconfirmed outcomes unknown', () => {
    const messages = restoreEvents(
      [
        event(1, 'tool_call', { toolCallId: 'a', toolName: 'write', args: {} }),
        event(2, 'tool_call', { toolCallId: 'b', toolName: 'read', args: {} }),
        event(3, 'tool_result', { toolCallId: 'b', result: 'ok', isError: false }),
      ],
      model
    );
    expect(messages.map((m) => m.role)).toEqual([
      'assistant',
      'toolResult',
      'assistant',
      'toolResult',
    ]);
    expect(messages[1]).toMatchObject({
      toolCallId: 'a',
      isError: true,
      content: [{ text: expect.stringContaining('Do not blindly repeat') }],
    });
    expect(messages[3]).toMatchObject({ toolCallId: 'b', isError: false });
    expect(keepRecentMessages(messages, 1)).toHaveLength(2);
  });
  it('does not join tool results from separate runs that reuse a provider toolCallId', () => {
    const messages = restoreEvents(
      [
        {
          ...event(1, 'tool_call', { toolCallId: 'same', toolName: 'write', args: {} }),
          runId: 'r1',
        },
        {
          ...event(2, 'tool_call', { toolCallId: 'same', toolName: 'read', args: {} }),
          runId: 'r2',
        },
        {
          ...event(3, 'tool_result', {
            toolCallId: 'same',
            result: 'second result',
            isError: false,
          }),
          runId: 'r2',
        },
      ],
      model
    );
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      toolCallId: 'same',
      isError: true,
      content: [{ text: expect.stringContaining('Outcome unknown') }],
    });
    expect(messages[3]).toMatchObject({
      toolCallId: 'same_2',
      isError: false,
      content: [{ text: '"second result"' }],
    });
    expect(messages[2]).toMatchObject({ content: [{ id: 'same_2' }] });
  });

  it('gives queued interactive sessions priority over tickets without exceeding slots', async () => {
    const slots = new SlotSemaphore(1),
      order: string[] = [];
    await slots.acquire();
    const ticket = slots.acquire('ticket').then(() => order.push('ticket'));
    const session = slots.acquire('session').then(() => order.push('session'));
    slots.release();
    await session;
    expect(order).toEqual(['session']);
    expect(slots.activeCount).toBe(1);
    slots.release();
    await ticket;
    expect(order).toEqual(['session', 'ticket']);
    slots.release();
    expect(slots.activeCount).toBe(0);
  });
});
