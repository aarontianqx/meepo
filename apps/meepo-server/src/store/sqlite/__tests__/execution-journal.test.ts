import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Run } from '@meepo/core';
import type { SequencedWorkerEvent } from '@meepo/protocol';

import { openDatabase } from '../database.js';
import { SqliteSessionRepository } from '../session-sqlite.js';
import { SqliteRunRepository } from '../run-sqlite.js';
import { SqliteExecutionJournal } from '../execution-journal-sqlite.js';
import { SqliteDispatchCommitter } from '../dispatch-committer-sqlite.js';

const run: Run = {
  id: 'r1',
  work: { kind: 'turn', turnRef: { sessionId: 's1', sourceId: 'm1' } },
  attempt: 1,
  status: 'dispatched',
  workerId: 'w1',
  createdAt: 100,
  leaseExpiresAt: 1000,
};

describe('durable execution boundary', () => {
  it('recovers committed events after restart and deduplicates a lost ACK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meepo-journal-'));
    let db = openDatabase(join(dir, 'test.db'));
    try {
      await new SqliteRunRepository(db).save(run);
      let journal = new SqliteExecutionJournal(db);
      const events: SequencedWorkerEvent[] = [
        { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 },
        {
          type: 'tool_execution_start',
          runId: 'r1',
          toolCallId: 'call-1',
          toolName: 'write',
          args: { path: 'file' },
          clientSeq: 2,
        },
        {
          type: 'tool_execution_end',
          runId: 'r1',
          toolCallId: 'call-1',
          result: { content: [{ type: 'text', text: 'ok' }] },
          isError: false,
          clientSeq: 3,
        },
      ];
      for (const event of events) expect(journal.TxAppend('w1', event, 200).accepted).toBe(true);
      db.close();
      db = openDatabase(join(dir, 'test.db'));
      journal = new SqliteExecutionJournal(db);
      expect(journal.TxAppend('w1', events[2], 250)).toMatchObject({
        accepted: true,
        duplicate: true,
        lastConfirmedClientSeq: 3,
      });
      expect(db.prepare('SELECT type FROM session_events ORDER BY seq').all()).toEqual([
        { type: 'tool_call' },
        { type: 'tool_result' },
      ]);
      expect(journal.listByRun('r1')).toHaveLength(3);
      const terminal: SequencedWorkerEvent = {
        type: 'run_completed',
        runId: 'r1',
        clientSeq: 4,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      expect(journal.TxAppend('w1', terminal, 300).accepted).toBe(true);
      expect(journal.TxAppend('w1', terminal, 1100).duplicate).toBe(true);
      expect(
        journal.TxAppend(
          'w1',
          { type: 'assistant_text', runId: 'r1', clientSeq: 5, content: 'late' },
          400
        ).reason
      ).toBe('run_terminal');
      expect(await new SqliteRunRepository(db).getById('r1')).toMatchObject({
        status: 'completed',
        lastClientSeq: 4,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fences unknown workers, expired leases and sequence gaps', async () => {
    const db = openDatabase(':memory:');
    try {
      await new SqliteRunRepository(db).save(run);
      const journal = new SqliteExecutionJournal(db);
      const event: SequencedWorkerEvent = {
        type: 'run_started',
        runId: 'r1',
        workerId: 'w1',
        clientSeq: 1,
      };
      expect(journal.TxAppend('w2', event, 200).reason).toBe('run_not_owned');
      expect(journal.TxAppend('w1', { ...event, clientSeq: 2 }, 200).reason).toBe('sequence_gap');
      expect(journal.TxAppend('w1', event, 1000).reason).toBe('lease_expired');
      expect(journal.listByRun('r1')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('atomically deduplicates incoming work and rolls back partially created work', async () => {
    const db = openDatabase(':memory:');
    try {
      const sessions = new SqliteSessionRepository(db);
      await sessions.save({
        id: 's1',
        spaceId: 'sp1',
        kind: 'main',
        chatId: 'chat',
        threadId: 'user',
        boundWorkerId: 'w1',
        status: 'active',
        createdAt: 100,
        lastActiveAt: 100,
      });
      const commit = new SqliteDispatchCommitter(db);
      const queued = {
        id: 'r1',
        sessionId: 's1',
        queuedAt: 100,
        envelope: {
          runId: 'r1',
          sessionId: 's1',
          spaceId: 'sp1',
          sessionKind: 'main' as const,
          prompt: 'hello',
          source: { kind: 'user_message' as const, messageId: 'm1' },
          delivery: 'wait' as const,
        },
      };
      const input = { role: 'user' as const, content: 'hello', timestamp: 100 };
      const ingress = { channelId: 'ch1', messageId: 'm1' };
      expect(commit.TxEnqueueTurn(run, queued, input, ingress)).toEqual({
        duplicate: false,
        seq: 1,
      });
      expect(commit.TxEnqueueTurn({ ...run, id: 'r2' }, queued, input, ingress).duplicate).toBe(
        true
      );
      expect(() =>
        commit.TxEnqueueTurn({ ...run, id: 'r3' }, queued, input, { ...ingress, messageId: 'm2' })
      ).toThrow();
      expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'r1' }]);
      expect(db.prepare('SELECT message_id FROM processed_messages').all()).toEqual([
        { message_id: 'm1' },
      ]);
      expect(db.prepare('SELECT seq FROM session_events').all()).toEqual([{ seq: 1 }]);
      const session = (await sessions.getById('s1'))!;
      await sessions.save({ ...session, status: 'closed' });
      expect(() =>
        commit.TxEnqueueTurn({ ...run, id: 'r4' }, { ...queued, id: 'r4' }, input, {
          ...ingress,
          messageId: 'm4',
        })
      ).toThrow('Session changed');
      expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'r1' }]);
    } finally {
      db.close();
    }
  });
});
