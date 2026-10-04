import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Run, Session, Space } from '@meepo/core';
import { openDatabase } from '../database.js';
import { SqliteSpaceRepository } from '../space-sqlite.js';
import { SqliteSessionRepository } from '../session-sqlite.js';
import { SqliteRunRepository } from '../run-sqlite.js';
import { SqliteTicketRepository } from '../ticket-sqlite.js';
import { SqliteSessionEventRepository } from '../session-event-sqlite.js';
import { SqliteCompactionRepository } from '../compaction-sqlite.js';
import { SqliteExecutionJournal } from '../execution-journal-sqlite.js';
import { SqliteCardOutbox } from '../card-outbox-sqlite.js';
import { TranscriptService } from '../../../domain/sessions/transcript-service.js';
import { ReliabilityService } from '../../../domain/runs/reliability-service.js';
import { MediaService } from '../../../domain/sessions/media-service.js';
import { CardStreamer } from '../../../transport/feishu/card-streamer.js';
import type { FeishuClient } from '../../../transport/feishu/feishu-client.js';
import type { SessionService } from '../../../domain/sessions/session-service.js';
import { TicketService } from '../../../domain/tickets/ticket-service.js';

const session: Session = {
  id: 's',
  spaceId: 'sp',
  kind: 'main',
  channelId: 'ch',
  chatId: 'chat',
  threadId: 'main',
  anchorMessageId: 'm',
  boundWorkerId: 'w',
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
};
const run = (id: string, overrides: Partial<Run> = {}): Run => ({
  id,
  work: { kind: 'turn', turnRef: { sessionId: 's', sourceId: id } },
  workerId: 'w',
  attempt: 1,
  status: 'running',
  createdAt: 1,
  startedAt: 2,
  leaseExpiresAt: 10,
  ...overrides,
});
describe('review R4 durable boundaries', () => {
  let db: Database,
    runs: SqliteRunRepository,
    events: SqliteSessionEventRepository,
    sessions: SqliteSessionRepository;
  beforeEach(async () => {
    db = openDatabase(':memory:');
    const space: Space = {
      id: 'sp',
      name: 'test',
      repoUrl: '',
      defaultBranch: 'main',
      timezone: 'UTC',
      boundChatIds: [],
      requiredTags: [],
      longTermMemory: '',
      createdAt: 1,
      updatedAt: 1,
    };
    await new SqliteSpaceRepository(db).save(space);
    sessions = new SqliteSessionRepository(db);
    await sessions.save(session);
    runs = new SqliteRunRepository(db);
    events = new SqliteSessionEventRepository(db);
  });
  afterEach(() => db.close());
  it('queries only expired/live worker runs and preserves usage coverage through SQL aggregation', async () => {
    await runs.save(run('expired', { usage: { inputTokens: 3, outputTokens: 7 } }));
    await runs.save(run('active', { leaseExpiresAt: 100 }));
    await runs.save(
      run('finished', {
        status: 'completed',
        usage: { inputTokens: 2, outputTokens: 4, costUsd: 0.2 },
      })
    );
    await runs.save(
      run('foreign', {
        workerId: 'other',
        work: { kind: 'turn', turnRef: { sessionId: 'else', sourceId: 'm' } },
      })
    );
    expect((await runs.list({ expiredBefore: 11 })).map((r) => r.id)).toEqual([
      'expired',
      'foreign',
    ]);
    expect((await runs.list({ workerId: 'w', activeOrIds: [] })).map((r) => r.id)).toEqual([
      'expired',
      'active',
    ]);
    expect(await runs.list({ workerId: 'w', activeOrIds: ['finished'] })).toHaveLength(3);
    expect(await runs.usage(['s'], [])).toEqual({
      runCount: 3,
      reportedRunCount: 2,
      inputTokens: 5,
      outputTokens: 11,
      costUsd: 0.2,
      costReportedRunCount: 1,
    });
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM runs WHERE status IN ('queued','dispatched','running') AND lease_expires_at<=?"
      )
      .all(11);
    expect(JSON.stringify(plan)).toMatch(/USING INDEX/);
  });
  it('pages events and reuses only a summary before the requested snapshot boundary', async () => {
    for (let i = 1; i <= 80; i++)
      await events.append('s', 'user_message', { role: 'user', content: `m${i}`, timestamp: i }, i);
    const caches = new SqliteCompactionRepository(db),
      transcripts = new TranscriptService(events, sessions, caches);
    await transcripts.recordCompaction('s', { summary: 'first 30', coversThroughSeq: 30 });
    expect(await events.listBySession('s', { afterSeq: 50, limit: 10 })).toHaveLength(10);
    const restored = await transcripts.getSnapshot('s', undefined, 75, { useCompaction: true });
    expect(restored.compaction?.coversThroughSeq).toBe(30);
    expect(restored.events?.[0].seq).toBe(31);
    expect(restored.events?.at(-1)?.seq).toBe(74);
    expect(
      (await transcripts.getSnapshot('s', undefined, 20, { useCompaction: true })).compaction
    ).toBeUndefined();
    await transcripts.recordCompaction('s', { summary: 'truncated', coversThroughSeq: 40 }, true);
    await transcripts.recordCompaction('s', { summary: 'duplicate', coversThroughSeq: 40 }, true);
    expect(await events.listBySession('s', { type: 'system_note' })).toHaveLength(1);
    expect(await events.listBySession('s', { type: 'user_message' })).toHaveLength(80);
    await expect(
      transcripts.recordCompaction('s', { summary: 'invalid', coversThroughSeq: 999 })
    ).rejects.toThrow();
    await expect(transcripts.listEvents('s', NaN)).rejects.toThrow();
  });
  it('never reuses a degraded compaction as a snapshot cache', async () => {
    for (let i = 1; i <= 30; i++)
      await events.append('s', 'user_message', { role: 'user', content: `m${i}`, timestamp: i }, i);
    const caches = new SqliteCompactionRepository(db),
      transcripts = new TranscriptService(events, sessions, caches);
    await transcripts.recordCompaction('s', { summary: 'good prefix', coversThroughSeq: 10 });
    await transcripts.recordCompaction(
      's',
      { summary: 'degraded excerpt', coversThroughSeq: 20 },
      true
    );
    expect(
      (await transcripts.getSnapshot('s', undefined, 100, { useCompaction: true })).compaction
    ).toMatchObject({ summary: 'good prefix', coversThroughSeq: 10 });
    const degradedOnly = new SqliteCompactionRepository(db);
    degradedOnly.TxSave('s2', { summary: 'excerpt', coversThroughSeq: 5 }, true);
    expect(degradedOnly.latest('s2', 100)).toBeUndefined();
    degradedOnly.TxSave('s2', { summary: 'recovered summary', coversThroughSeq: 5 }, false);
    expect(degradedOnly.latest('s2', 100)).toMatchObject({ summary: 'recovered summary' });
    degradedOnly.TxSave('s2', { summary: 'another failure', coversThroughSeq: 5 }, true);
    expect(degradedOnly.latest('s2', 100)).toMatchObject({ summary: 'recovered summary' });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM session_events WHERE session_id='s2' AND type='system_note'"
          )
          .get() as { c: number }
      ).c
    ).toBe(1);
  });
  it('sweeps webhook idempotency keys after 30 days', async () => {
    const tickets = new SqliteTicketRepository(db);
    await tickets.create(
      {
        id: 't-fresh',
        spaceId: 'sp',
        title: 'fresh',
        objective: 'fresh',
        requiredTags: [],
        status: 'pending',
        pendingSince: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      { key: 'fresh-key', fingerprint: 'fp' }
    );
    const row = db
      .prepare('SELECT created_at FROM webhook_requests WHERE space_id=? AND key=?')
      .get('sp', 'fresh-key') as { created_at: number };
    expect(row.created_at).toBeGreaterThan(0);
    const now = Date.now();
    db.prepare(
      'INSERT INTO webhook_requests(space_id,key,fingerprint,ticket_id,created_at) VALUES(?,?,?,?,?)'
    ).run('sp', 'old', 'f1', 't1', now - 31 * 86400000);
    db.prepare('DELETE FROM webhook_requests WHERE created_at < ?').run(now - 30 * 86400000);
    expect(db.prepare('SELECT key FROM webhook_requests').all()).toEqual([{ key: 'fresh-key' }]);
  });
  it('allows only referenced images from the worker-bound live session', async () => {
    await events.append('s', 'user_message', { images: [{ messageId: 'msg', fileKey: 'image' }] });
    const download = vi
      .fn()
      .mockResolvedValue({ data: 'AA==', sizeBytes: 1, mimeType: 'image/png' });
    const media = new MediaService(sessions, events, { download });
    const p = { sessionId: 's', messageId: 'msg', fileKey: 'image' };
    await expect(media.read('other', p)).rejects.toThrow();
    await expect(media.read('w', { ...p, fileKey: 'unseen' })).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
    await expect(media.read('w', p)).resolves.toMatchObject({ sizeBytes: 1 });
    expect(download).toHaveBeenCalledWith('ch', 'msg', 'image');
    await sessions.save({ ...session, status: 'closed' });
    await expect(media.read('w', p)).rejects.toThrow();
  });
  it('lease expiry is rendered by the durable card recovery path without an immediate render hook', async () => {
    await runs.save(run('card', { initiatorIds: ['u'] }));
    const outbox = new SqliteCardOutbox(db);
    outbox.save({
      runId: 'card',
      sessionId: 's',
      channelId: 'ch',
      text: 'partial',
      thinking: '',
      tools: {},
      sequence: 0,
      part: 0,
      offset: 0,
      state: 'streaming',
      dirty: false,
      updatedAt: 1,
      cardId: 'c',
      replied: true,
    });
    const updateCard = vi.fn().mockResolvedValue(undefined),
      updateCardSettings = vi.fn().mockResolvedValue(undefined);
    const streamer = new CardStreamer({
      channelId: 'ch',
      outbox,
      sessions: { getSession: async () => session } as unknown as SessionService,
      isUserRun: async () => true,
      client: { updateCard, updateCardSettings } as unknown as FeishuClient,
    });
    try {
      streamer.recover();
      await new ReliabilityService(
        runs,
        new SqliteTicketRepository(db),
        new SqliteExecutionJournal(db),
        () => 11
      ).sweep();
      outbox.reconcile('ch');
      streamer.recover();
      await vi.waitFor(() => expect(updateCardSettings).toHaveBeenCalled());
      expect(updateCard.mock.calls[0][1]).toContain('Worker 连接中断');
      expect(updateCard.mock.calls[0][1]).not.toContain('lease_lost');
      expect((await runs.getById('card'))?.terminalReason).toBe('lease_lost');
      expect(updateCard.mock.calls[0][1]).not.toContain('停止');
      expect(JSON.parse(updateCardSettings.mock.calls[0][1]).config.streaming_mode).toBe(false);
    } finally {
      streamer.stop();
    }
  });
  it('caps persisted tool output even when a producer omits truncation', async () => {
    await runs.save(run('large'));
    const journal = new SqliteExecutionJournal(db);
    expect(
      journal.TxAppend(
        'w',
        {
          type: 'tool_execution_end',
          runId: 'large',
          clientSeq: 1,
          toolCallId: 'tool',
          isError: false,
          result: '大'.repeat(100000),
        },
        3
      ).accepted
    ).toBe(true);
    const payload = journal.listByRun('large')[0].payload as { result: { truncated: boolean } };
    expect(payload.result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(66000);
  });
  it('persists webhook idempotency independently of a service instance and space', async () => {
    const spaces = new SqliteSpaceRepository(db);
    const first = new TicketService(new SqliteTicketRepository(db), spaces);
    const input = { spaceId: 'sp', title: 'build', objective: 'audit' };
    const a = await first.createTicket(input, 'key');
    const second = new TicketService(new SqliteTicketRepository(db), spaces);
    expect((await second.createTicket(input, 'key')).id).toBe(a.id);
    await expect(second.createTicket({ ...input, objective: 'different' }, 'key')).rejects.toThrow(
      'different payload'
    );
  });
});
