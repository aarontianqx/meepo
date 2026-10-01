import { describe, it, expect, vi } from 'vitest';
import { ReceiptService } from '../receipt-service.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';

describe('ReceiptService failure isolation', () => {
  it('keeps an undeliverable receipt pending while delivering later receipts', async () => {
    const sessions = new MemorySessionRepository();
    for (const id of ['bad', 'good'])
      await sessions.save({
        id,
        spaceId: id,
        kind: 'main',
        chatId: id,
        threadId: id,
        status: 'active',
        createdAt: 0,
        lastActiveAt: 0,
      });
    const receipts = {
      pending: () =>
        ['bad', 'good'].map((id) => ({ runId: id, sessionId: id, content: id, timestamp: 1 })),
      delivered: vi.fn(),
      TxDeliverClosed: vi.fn(),
    };
    const dispatchSessionTurn = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'bad') throw new Error('Unknown model');
      return { dispatched: true, queued: false };
    });
    const onError = vi.fn();
    await new ReceiptService(receipts, sessions, { dispatchSessionTurn }, onError).flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(receipts.delivered.mock.calls).toEqual([['good']]);
    expect(dispatchSessionTurn).toHaveBeenCalledTimes(2);
  });
});
