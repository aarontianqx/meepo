import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QueuedDispatch } from '../../../domain/dispatch/dispatch-queue-repository.js';
import { openDatabase } from '../database.js';
import { SqliteDispatchQueueRepository } from '../dispatch-queue-sqlite.js';

function makeItem(overrides: Partial<QueuedDispatch> = {}): QueuedDispatch {
  return {
    id: 'dispatch-1',
    sessionId: 'session-1',
    envelope: {
      taskId: 'task-1',
      sessionId: 'session-1',
      spaceId: 'space-1',
      sessionKind: 'main',
      prompt: 'hello',
      source: { kind: 'user_message', messageId: 'msg-1' },
      delivery: 'wait',
      model: {
        provider: 'openai-completions',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: 'm',
      },
    },
    queuedAt: 1000,
    ...overrides,
  };
}

describe('SqliteDispatchQueueRepository', () => {
  let db: Database;
  let repo: SqliteDispatchQueueRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteDispatchQueueRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues and lists items by session', async () => {
    await repo.enqueue(makeItem());

    expect(await repo.listBySession('session-1')).toEqual([makeItem()]);
  });

  it('round-trips the full envelope', async () => {
    const item = makeItem({
      envelope: {
        taskId: 'task-2',
        sessionId: 'session-1',
        spaceId: 'space-1',
        sessionKind: 'task',
        prompt: 'run',
        source: { kind: 'cron', jobId: 'job-1', coalescedCount: 3, stale: true },
        delivery: 'urgent',
        model: {
          provider: 'openai-completions',
          baseUrl: 'https://api.example.com',
          apiKey: 'k',
          model: 'm',
        },
        timeoutSeconds: 600,
      },
    });
    await repo.enqueue(item);

    expect(await repo.listBySession('session-1')).toEqual([item]);
  });

  it('lists items ordered by queuedAt', async () => {
    await repo.enqueue(makeItem({ id: 'dispatch-3', queuedAt: 3000 }));
    await repo.enqueue(makeItem({ id: 'dispatch-1', queuedAt: 1000 }));
    await repo.enqueue(makeItem({ id: 'dispatch-2', queuedAt: 2000 }));
    await repo.enqueue(makeItem({ id: 'dispatch-9', sessionId: 'session-2', queuedAt: 500 }));

    const items = await repo.listBySession('session-1');
    expect(items.map((item) => item.id)).toEqual(['dispatch-1', 'dispatch-2', 'dispatch-3']);
  });

  it('deletes all items for a session', async () => {
    await repo.enqueue(makeItem());
    await repo.enqueue(makeItem({ id: 'dispatch-2', queuedAt: 2000 }));
    await repo.enqueue(makeItem({ id: 'dispatch-3', sessionId: 'session-2' }));

    await repo.deleteBySession('session-1');

    expect(await repo.listBySession('session-1')).toEqual([]);
    expect(await repo.listBySession('session-2')).toHaveLength(1);
  });

  it('lists distinct session ids with queued items', async () => {
    expect(await repo.listSessionIds()).toEqual([]);

    await repo.enqueue(makeItem());
    await repo.enqueue(makeItem({ id: 'dispatch-2', queuedAt: 2000 }));
    await repo.enqueue(makeItem({ id: 'dispatch-3', sessionId: 'session-2' }));

    expect((await repo.listSessionIds()).sort()).toEqual(['session-1', 'session-2']);

    await repo.deleteBySession('session-1');
    expect(await repo.listSessionIds()).toEqual(['session-2']);
  });
});
