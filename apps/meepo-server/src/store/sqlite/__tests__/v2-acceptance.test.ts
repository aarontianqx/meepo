import { TicketService } from '../../../domain/tickets/ticket-service.js';
import { PromptService } from '../../../domain/prompts/prompt-service.js';
import { TranscriptService } from '../../../domain/sessions/transcript-service.js';
import { SqliteSessionEventRepository } from '../session-event-sqlite.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Run, Session, Space, Ticket, Schedule } from '@meepo/core';
import type { SequencedWorkerEvent } from '@meepo/protocol';
import { openDatabase } from '../database.js';
import { SqliteRunRepository } from '../run-sqlite.js';
import { SqliteSessionRepository } from '../session-sqlite.js';
import { SqliteSpaceRepository } from '../space-sqlite.js';
import { SqliteTicketRepository } from '../ticket-sqlite.js';
import { SqliteScheduleRepository } from '../schedule-sqlite.js';
import { SqliteExecutionJournal } from '../execution-journal-sqlite.js';
import { SqliteDispatchCommitter } from '../dispatch-committer-sqlite.js';
import { SqliteFireCommitter } from '../fire-committer-sqlite.js';
import { SqliteSessionLifecycle } from '../session-lifecycle-sqlite.js';
import { SqliteMemoryRepository } from '../memory-sqlite.js';
import { SqliteCardOutbox } from '../card-outbox-sqlite.js';
import { ReliabilityService } from '../../../domain/runs/reliability-service.js';
import { MemoryService } from '../../../domain/memory/memory-service.js';

class FakeClock {
  value = 100;
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
  }
}
/** The worker may stay alive while transport is disconnected: its late event is still replayed. */
class InProcessWorker {
  sequence = 0;
  connected = true;
  buffered: SequencedWorkerEvent[] = [];
  constructor(
    readonly id: string,
    readonly runId: string,
    private readonly clock: FakeClock,
    private readonly journal: () => SqliteExecutionJournal
  ) {}
  send(
    event: Omit<Extract<SequencedWorkerEvent, { type: 'run_completed' }>, 'clientSeq' | 'runId'>
  ) {
    const frame = {
      ...event,
      runId: this.runId,
      clientSeq: ++this.sequence,
    } as SequencedWorkerEvent;
    if (!this.connected) {
      this.buffered.push(frame);
      return;
    }
    return this.journal().TxAppend(this.id, frame, this.clock.now());
  }
  replay() {
    this.connected = true;
    return this.buffered
      .splice(0)
      .map((e) => this.journal().TxAppend(this.id, e, this.clock.now()));
  }
}
const space: Space = {
  id: 'sp1',
  name: 'Test',
  repoUrl: '',
  defaultBranch: 'main',
  timezone: 'UTC',
  boundChatIds: ['chat'],
  requiredTags: [],
  longTermMemory: '',
  createdAt: 100,
  updatedAt: 100,
  boundWorkerId: 'w1',
};
const session: Session = {
  id: 's1',
  spaceId: 'sp1',
  kind: 'main',
  boundWorkerId: 'w1',
  channelId: 'ch1',
  chatId: 'chat',
  threadId: 'main',
  status: 'active',
  createdAt: 100,
  lastActiveAt: 100,
};
const run = (id: string, overrides: Partial<Run> = {}): Run => ({
  id,
  work: { kind: 'turn', turnRef: { sessionId: 's1', sourceId: id } },
  attempt: 1,
  workerId: 'w1',
  status: 'dispatched',
  createdAt: 100,
  leaseExpiresAt: 1000,
  ...overrides,
});
const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id,
  spaceId: 'sp1',
  title: id,
  objective: 'test',
  requiredTags: [],
  status: 'pending',
  pendingSince: 100,
  attempt: 0,
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});
const queued = (id: string) => ({
  id,
  sessionId: 's1',
  queuedAt: 100,
  envelope: {
    runId: id,
    sessionId: 's1',
    spaceId: 'sp1',
    sessionKind: 'main' as const,
    prompt: id,
    delivery: 'wait' as const,
    source: { kind: 'system' as const },
  },
});

describe('v2 cross-module fault contracts', () => {
  let db: Database;
  let dir: string;
  let clock: FakeClock;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'meepo-v2-'));
    db = openDatabase(join(dir, 'state.db'));
    clock = new FakeClock();
    await new SqliteSpaceRepository(db).save(space);
    await new SqliteSessionRepository(db).save(session);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('1: redelivery after server restart keeps one input/run and rebuilds a lost render handoff', () => {
    const input = { role: 'user' as const, content: 'hello', timestamp: 100 },
      ingress = { channelId: 'ch1', messageId: 'm1' };
    new SqliteDispatchCommitter(db).TxEnqueueTurn(run('r1'), queued('r1'), input, ingress);
    const journal = new SqliteExecutionJournal(db);
    journal.TxAppend('w1', { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 }, 110);
    journal.TxAppend(
      'w1',
      { type: 'assistant_text', runId: 'r1', content: 'done', clientSeq: 2 },
      120
    );
    journal.TxAppend('w1', { type: 'run_completed', runId: 'r1', clientSeq: 3 }, 130);
    db.close();
    db = openDatabase(join(dir, 'state.db'));
    expect(
      new SqliteDispatchCommitter(db).TxEnqueueTurn(
        run('duplicate'),
        queued('duplicate'),
        input,
        ingress
      ).duplicate
    ).toBe(true);
    expect(db.prepare('SELECT id FROM runs').all()).toHaveLength(1);
    const outbox = new SqliteCardOutbox(db);
    outbox.reconcile('ch1');
    expect(outbox.get('r1')).toMatchObject({ text: 'done', state: 'completed', dirty: true });
    outbox.reconcile('ch1');
    expect(outbox.listPending('ch1')).toHaveLength(1);
  });
  it('2: queue merge preserves first run and initiators, with one terminal outcome per source', async () => {
    const commit = new SqliteDispatchCommitter(db);
    for (let i = 1; i <= 3; i++)
      commit.TxEnqueueTurn(
        run(`r${i}`, { status: 'queued', initiatorIds: [`u${i}`] }),
        queued(`r${i}`),
        { role: 'user', content: String(i), timestamp: 100 + i }
      );
    expect(
      commit.TxMergeQueue(
        [queued('r1'), queued('r2'), queued('r3')],
        { ...queued('r1').envelope, mergedSourceIds: ['r1', 'r2', 'r3'] },
        'w1',
        1000,
        110
      )
    ).toBe(true);
    expect(await new SqliteRunRepository(db).getById('r1')).toMatchObject({
      initiatorIds: ['u1', 'u2', 'u3'],
      status: 'dispatched',
    });
    const journal = new SqliteExecutionJournal(db);
    expect(
      journal.TxAppend(
        'w1',
        { type: 'run_failed', runId: 'r1', clientSeq: 1, error: 'stop', code: 'interrupted' },
        120
      ).accepted
    ).toBe(true);
    expect(
      journal.TxAppend('w1', { type: 'run_completed', runId: 'r2', clientSeq: 1 }, 120).reason
    ).toBe('run_terminal');
    expect((await new SqliteRunRepository(db).list()).map((r) => r.status)).toEqual([
      'failed',
      'merged',
      'merged',
    ]);
  });
  it('3: disconnected live worker cannot renew/replay expired side effects; ticket parks for review', async () => {
    const tickets = new SqliteTicketRepository(db),
      runs = new SqliteRunRepository(db),
      journal = new SqliteExecutionJournal(db);
    await tickets.save(ticket('t1', { status: 'claimed', assignedWorkerId: 'w1', attempt: 1 }));
    await runs.save(run('r1', { work: { kind: 'ticket', ticketId: 't1' } }));
    journal.TxAppend('w1', { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 }, 100);
    journal.TxAppend(
      'w1',
      {
        type: 'tool_execution_start',
        runId: 'r1',
        toolCallId: 'effect',
        toolName: 'bash',
        args: { command: 'external effect' },
        clientSeq: 2,
      },
      110
    );
    const worker = new InProcessWorker('w1', 'r1', clock, () => new SqliteExecutionJournal(db));
    worker.sequence = 2;
    worker.connected = false;
    worker.send({ type: 'run_completed', resultSummary: 'late success' });
    const reliability = new ReliabilityService(runs, tickets, journal, clock.now);
    await reliability.sweep();
    expect((await tickets.getById('t1'))?.status).toBe('running');
    clock.advance(1000);
    await reliability.sweep();
    expect((await tickets.getById('t1'))?.status).toBe('manual_review');
    expect(worker.replay()[0].reason).toBe('run_terminal');
    expect((await runs.getById('r1'))?.terminalReason).toBe('lease_lost');
  });
  it('4: schedule creation failure rolls back fire and schedule cursor; retry is idempotent', async () => {
    const schedule: Schedule = {
      id: 'sc1',
      spaceId: 'sp1',
      timing: { kind: 'at', at: 100 },
      action: { kind: 'create_ticket', objective: 'test', requiredTags: [] },
      status: 'active',
      createdByUserId: 'u',
      createdAt: 1,
    };
    await new SqliteScheduleRepository(db).save(schedule);
    await new SqliteTicketRepository(db).save(ticket('collision'));
    const committer = new SqliteFireCommitter(db);
    const work = {
      fireId: 'fire1',
      schedule: { ...schedule, status: 'done' as const, lastFiredAt: 100 },
      ticket: ticket('collision'),
    };
    expect(() => committer.TxFire(work)).toThrow();
    expect(db.prepare('SELECT * FROM schedule_fires').all()).toEqual([]);
    expect((await new SqliteScheduleRepository(db).getById('sc1'))?.status).toBe('active');
    const valid = { ...work, ticket: ticket('fresh') };
    expect(committer.TxFire(valid)).toBe(true);
    expect((await new SqliteTicketRepository(db).getById('fresh'))?.pendingSince).toBe(100);
    expect(committer.TxFire(valid)).toBe(false);
    expect(db.prepare('SELECT * FROM schedule_fires').all()).toHaveLength(1);
  });
  it('5: rebind interrupts main only, migrates queued inputs, and close cancels schedules', async () => {
    const sessions = new SqliteSessionRepository(db),
      runs = new SqliteRunRepository(db),
      lifecycle = new SqliteSessionLifecycle(db);
    await sessions.save({ ...session, id: 'thread', kind: 'thread', threadId: 'topic' });
    await runs.save(run('active', { status: 'running', startedAt: 100 }));
    await runs.save(
      run('thread-run', {
        status: 'running',
        work: { kind: 'turn', turnRef: { sessionId: 'thread', sourceId: 'thread-input' } },
      })
    );
    new SqliteDispatchCommitter(db).TxEnqueueTurn(
      run('queued', { status: 'queued' }),
      queued('queued'),
      { role: 'user', content: 'next', timestamp: 101 }
    );
    await new SqliteScheduleRepository(db).save({
      id: 'resume',
      spaceId: 'sp1',
      timing: { kind: 'at', at: 500 },
      action: { kind: 'resume_session', sessionId: 's1', prompt: 'wake' },
      status: 'active',
      createdByUserId: 'u',
      createdAt: 100,
    });
    lifecycle.TxRebind('sp1', 'w2', 200);
    expect(await runs.getById('active')).toMatchObject({
      status: 'failed',
      terminalReason: 'interrupted',
    });
    expect(await runs.getById('thread-run')).toMatchObject({ status: 'running', workerId: 'w1' });
    expect(await runs.getById('queued')).toMatchObject({ status: 'queued', workerId: 'w2' });
    lifecycle.TxClose('s1', 210);
    expect((await runs.getById('queued'))?.status).toBe('failed');
    expect((await new SqliteScheduleRepository(db).getById('resume'))?.status).toBe('deleted');
    expect(db.prepare('SELECT * FROM dispatch_queue').all()).toEqual([]);
  });
  it('6: concurrent console memory edit and ticket completion keep separate durable streams', async () => {
    const memory = new MemoryService(new SqliteMemoryRepository(db));
    memory.write(
      'sp1',
      { path: 'qa/rules', description: 'test', content: 'v1', expected_revision: 0 },
      { kind: 'console', userId: 'u' }
    );
    await new SqliteTicketRepository(db).save(
      ticket('t1', { status: 'claimed', attempt: 1, originSessionId: 's1' })
    );
    await new SqliteRunRepository(db).save(run('r1', { work: { kind: 'ticket', ticketId: 't1' } }));
    const journal = new SqliteExecutionJournal(db);
    journal.TxAppend('w1', { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 }, 110);
    memory.write(
      'sp1',
      { path: 'qa/rules', description: 'test', content: 'v2', expected_revision: 1 },
      { kind: 'console', userId: 'u' }
    );
    journal.TxAppend(
      'w1',
      { type: 'assistant_text', runId: 'r1', content: 'ticket-private trace', clientSeq: 2 },
      120
    );
    journal.TxAppend(
      'w1',
      { type: 'run_completed', runId: 'r1', resultSummary: 'receipt', clientSeq: 3 },
      130
    );
    expect(memory.read('sp1', 'qa/rules').content).toBe('v2');
    expect(db.prepare('SELECT * FROM ticket_receipts').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM session_events').all()).toEqual([]);
    expect(journal.listByRun('r1').map((e) => e.type)).toContain('assistant_text');
  });
  it('7: same message ID and chat in two channels stay isolated', async () => {
    await new SqliteSessionRepository(db).save({ ...session, id: 's2', channelId: 'ch2' });
    const c = new SqliteDispatchCommitter(db);
    c.TxEnqueueTurn(
      run('r1'),
      queued('r1'),
      { role: 'user', content: 'one', timestamp: 100 },
      { channelId: 'ch1', messageId: 'same' }
    );
    const second = run('r2', {
      work: { kind: 'turn', turnRef: { sessionId: 's2', sourceId: 'same' } },
    });
    c.TxEnqueueTurn(
      second,
      { ...queued('r2'), sessionId: 's2', envelope: { ...queued('r2').envelope, sessionId: 's2' } },
      { role: 'user', content: 'two', timestamp: 100 },
      { channelId: 'ch2', messageId: 'same' }
    );
    expect(db.prepare('SELECT * FROM processed_messages').all()).toHaveLength(2);
    expect(
      (await new SqliteSessionRepository(db).getByThread('sp1', 'chat', 'main', 'ch1'))?.id
    ).toBe('s1');
    expect(
      (await new SqliteSessionRepository(db).getByThread('sp1', 'chat', 'main', 'ch2'))?.id
    ).toBe('s2');
  });
  it('8: an unconfirmed tool result remains absent after restart; confirmed IDs survive replay', async () => {
    await new SqliteRunRepository(db).save(run('r1'));
    const j = new SqliteExecutionJournal(db);
    j.TxAppend('w1', { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 }, 100);
    j.TxAppend(
      'w1',
      {
        type: 'tool_execution_start',
        runId: 'r1',
        toolCallId: 'unique-call',
        toolName: 'write',
        args: { path: 'output' },
        clientSeq: 2,
      },
      110
    );
    db.close();
    db = openDatabase(join(dir, 'state.db'));
    const events = new SqliteExecutionJournal(db).listByRun('r1');
    expect(events.filter((e) => e.type === 'tool_call')).toMatchObject([
      { payload: { toolCallId: 'unique-call' } },
    ]);
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });
  it('atomic reset deduplicates /new, cancels queued work and stores one notice', async () => {
    const commit = new SqliteDispatchCommitter(db);
    commit.TxEnqueueTurn(run('r1'), queued('r1'), { role: 'user', content: 'old', timestamp: 100 });
    const lifecycle = new SqliteSessionLifecycle(db);
    const ingress = { channelId: 'ch1', messageId: 'new-command' };
    expect(lifecycle.TxReset('s1', 's2', 'new-command', ingress, 120).duplicate).toBe(false);
    expect(lifecycle.TxReset('s2', 's3', 'new-command', ingress, 130).duplicate).toBe(true);
    expect((await new SqliteSessionRepository(db).getById('s1'))?.status).toBe('closed');
    expect((await new SqliteRunRepository(db).getById('r1'))?.status).toBe('failed');
    expect(db.prepare('SELECT * FROM message_outbox').all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM sessions WHERE status='active'").all()).toHaveLength(1);
  });
  it('cancellation fences a claimed worker and stale updates cannot resurrect the ticket', async () => {
    const tickets = new SqliteTicketRepository(db),
      journal = new SqliteExecutionJournal(db);
    const t = ticket('t1', {
      status: 'claimed',
      attempt: 1,
      assignedWorkerId: 'w1',
      originSessionId: 's1',
    });
    await tickets.save(t);
    await new SqliteRunRepository(db).save(run('r1', { work: { kind: 'ticket', ticketId: 't1' } }));
    await tickets.save(
      { ...t, status: 'cancelled', updatedAt: 120, completedAt: 120 },
      { status: 'claimed', attempt: 1 }
    );
    expect(
      journal.TxAppend(
        'w1',
        { type: 'run_started', runId: 'r1', workerId: 'w1', clientSeq: 1 },
        130
      ).reason
    ).toBe('run_terminal');
    await expect(
      tickets.save({ ...t, status: 'running' }, { status: 'claimed', attempt: 1 })
    ).rejects.toThrow('concurrently');
    expect(db.prepare('SELECT * FROM ticket_receipts').all()).toHaveLength(1);
  });
  it('concurrent running-ticket cancellation is idempotent, rejects late completion and never retries', async () => {
    const tickets = new SqliteTicketRepository(db),
      runs = new SqliteRunRepository(db),
      journal = new SqliteExecutionJournal(db);
    const service = new TicketService(tickets, new SqliteSpaceRepository(db));
    await tickets.save(
      ticket('cancel-running', {
        status: 'running',
        attempt: 1,
        originSessionId: 's1',
        assignedWorkerId: 'w1',
      })
    );
    await runs.save(
      run('cancel-running-run', {
        status: 'running',
        startedAt: 110,
        work: { kind: 'ticket', ticketId: 'cancel-running' },
      })
    );
    const [first, second] = await Promise.all([
      service.cancelTicket('cancel-running'),
      service.cancelTicket('cancel-running'),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: 'cancelled', terminalReason: 'cancelled' });
    expect(
      journal.TxAppend(
        'w1',
        {
          type: 'run_completed',
          runId: 'cancel-running-run',
          clientSeq: 1,
          resultSummary: 'late result',
        },
        120
      ).reason
    ).toBe('run_terminal');
    clock.advance(2 * 86400000);
    await new ReliabilityService(runs, tickets, journal, clock.now).sweep();
    expect(await tickets.getById('cancel-running')).toEqual(first);
    expect(await runs.getById('cancel-running-run')).toMatchObject({
      status: 'failed',
      terminalReason: 'cancelled',
    });
    expect(await runs.listByTicket('cancel-running')).toHaveLength(1);
    expect(db.prepare('SELECT * FROM ticket_receipts').all()).toHaveLength(1);
    await expect(service.requeueTicket('cancel-running')).rejects.toThrow('manual_review');
  });

  it('completion committed during cancellation wins without being overwritten', async () => {
    const tickets = new SqliteTicketRepository(db),
      runs = new SqliteRunRepository(db),
      journal = new SqliteExecutionJournal(db);
    const service = new TicketService(tickets, new SqliteSpaceRepository(db));
    await tickets.save(
      ticket('completion-wins', {
        status: 'running',
        attempt: 1,
        originSessionId: 's1',
        assignedWorkerId: 'w1',
      })
    );
    await runs.save(
      run('completion-run', {
        status: 'running',
        startedAt: 110,
        work: { kind: 'ticket', ticketId: 'completion-wins' },
      })
    );
    const save = tickets.save.bind(tickets);
    vi.spyOn(tickets, 'save').mockImplementationOnce(async (...args) => {
      expect(
        journal.TxAppend(
          'w1',
          {
            type: 'run_completed',
            runId: 'completion-run',
            clientSeq: 1,
            resultSummary: 'completed first',
          },
          120
        ).accepted
      ).toBe(true);
      await save(...args);
    });
    await expect(service.cancelTicket('completion-wins')).rejects.toThrow('concurrently');
    expect(await tickets.getById('completion-wins')).toMatchObject({
      status: 'completed',
      result: { summary: 'completed first' },
    });
    expect((await runs.getById('completion-run'))?.status).toBe('completed');
    expect(db.prepare('SELECT * FROM ticket_receipts').all()).toHaveLength(1);
  });

  it('manual retry gets a full pending interval independent of creation and unrelated updates', async () => {
    const tickets = new SqliteTicketRepository(db);
    const service = new TicketService(tickets, new SqliteSpaceRepository(db));
    await tickets.save(ticket('retry', { status: 'manual_review', attempt: 1 }));
    clock.advance(2 * 86400000);
    vi.spyOn(Date, 'now').mockImplementation(clock.now);
    const retried = await service.requeueTicket('retry');
    expect(retried.createdAt).toBe(100);
    expect(retried.pendingSince).toBe(clock.now());
    const sweep = new ReliabilityService(
      new SqliteRunRepository(db),
      tickets,
      new SqliteExecutionJournal(db),
      clock.now
    );
    await sweep.sweep();
    expect((await tickets.getById('retry'))?.status).toBe('pending');
    clock.advance(86400000 - 1);
    await tickets.save({ ...retried, title: 'edited', updatedAt: clock.now() });
    await sweep.sweep();
    expect((await tickets.getById('retry'))?.status).toBe('pending');
    clock.advance(1);
    await sweep.sweep();
    expect(await tickets.getById('retry')).toMatchObject({
      status: 'failed',
      terminalReason: 'unclaimed',
      createdAt: 100,
    });
  });

  it('automatic retry resets pendingSince atomically and survives the same sweep and restart', async () => {
    const tickets = new SqliteTicketRepository(db),
      runs = new SqliteRunRepository(db);
    await tickets.save(ticket('retry', { status: 'claimed', attempt: 1 }));
    await runs.save(run('retry-run', { work: { kind: 'ticket', ticketId: 'retry' } }));
    clock.advance(2 * 86400000);
    await new ReliabilityService(runs, tickets, new SqliteExecutionJournal(db), clock.now).sweep();
    db.close();
    db = openDatabase(join(dir, 'state.db'));
    const reopened = new SqliteTicketRepository(db);
    expect(await reopened.getById('retry')).toMatchObject({
      status: 'pending',
      pendingSince: clock.now(),
      createdAt: 100,
    });
    const sweep = new ReliabilityService(
      new SqliteRunRepository(db),
      reopened,
      new SqliteExecutionJournal(db),
      clock.now
    );
    clock.advance(86400000 - 1);
    await sweep.sweep();
    expect((await reopened.getById('retry'))?.status).toBe('pending');
    clock.advance(1);
    await sweep.sweep();
    expect(await reopened.getById('retry')).toMatchObject({
      status: 'failed',
      terminalReason: 'unclaimed',
    });
  });

  it('expired final attempts and unclaimed tickets persist exactly one origin receipt', async () => {
    const tickets = new SqliteTicketRepository(db),
      runs = new SqliteRunRepository(db);
    await tickets.save(ticket('t1', { status: 'claimed', attempt: 3, originSessionId: 's1' }));
    await runs.save(run('r1', { work: { kind: 'ticket', ticketId: 't1' }, attempt: 3 }));
    clock.advance(1000);
    const sweep = new ReliabilityService(runs, tickets, new SqliteExecutionJournal(db), clock.now);
    await sweep.sweep();
    await sweep.sweep();
    await tickets.save(ticket('t2', { originSessionId: 's1' }));
    clock.advance(86400000);
    await sweep.sweep();
    await sweep.sweep();
    expect(db.prepare('SELECT * FROM ticket_receipts').all()).toHaveLength(2);
  });
  it('merge rejects another session, and recovery never rewrites a dispatched envelope', async () => {
    const runs = new SqliteRunRepository(db),
      journal = new SqliteExecutionJournal(db);
    await runs.save(run('r1'));
    await runs.save(
      run('r2', { work: { kind: 'turn', turnRef: { sessionId: 'other', sourceId: 'm2' } } })
    );
    expect(
      journal.TxAppend(
        'w1',
        { type: 'run_merged', runId: 'r1', mergedIntoRunId: 'r2', clientSeq: 1 },
        120
      ).reason
    ).toBe('invalid_merge_target');
    expect(
      new SqliteDispatchCommitter(db).TxMergeQueue(
        [queued('r1'), queued('r2')],
        queued('r1').envelope,
        'w1',
        1000,
        120
      )
    ).toBe(false);
    journal.TxInterrupt('r1', 'interrupted', 120);
    journal.TxRenew('w1', ['r1'], 1000, 130);
    expect(await runs.getById('r1')).toMatchObject({ status: 'failed', leaseExpiresAt: 1000 });
  });
  it('worker-side merging keeps the primary author first regardless of run ID sort order', async () => {
    const runs = new SqliteRunRepository(db),
      journal = new SqliteExecutionJournal(db);
    await runs.save(run('z-primary', { initiatorIds: ['first'] }));
    await runs.save(run('a-followup', { initiatorIds: ['second'] }));
    expect(
      journal.TxAppend(
        'w1',
        { type: 'run_merged', runId: 'a-followup', mergedIntoRunId: 'z-primary', clientSeq: 1 },
        120
      ).accepted
    ).toBe(true);
    expect((await runs.getById('z-primary'))?.initiatorIds).toEqual(['first', 'second']);
  });

  it('cold prompt refresh keeps identity frozen and supplies only a current directory memory map', async () => {
    const spaces = new SqliteSpaceRepository(db),
      sessions = new SqliteSessionRepository(db);
    const memory = new MemoryService(new SqliteMemoryRepository(db));
    const prompt = new PromptService(
      spaces,
      sessions,
      new TranscriptService(new SqliteSessionEventRepository(db), sessions),
      memory
    );
    const first = await prompt.prepare('sp1', 's1');
    await spaces.save({ ...space, name: 'Renamed', promptPreset: 'coding' });
    memory.write(
      'sp1',
      { path: 'rules/payment', description: 'Rule', content: 'PRIVATE_BODY', expected_revision: 0 },
      { kind: 'console', userId: 'u' }
    );
    const cold = await prompt.prepare('sp1', 's1');
    expect(cold.base).toBe(first.base);
    expect(cold.memoryMap).toContain('rules');
    expect(cold.memoryMap).not.toContain('PRIVATE_BODY');
    expect((await prompt.prepare('sp1')).base).toContain('Coding preset');
  });
});
