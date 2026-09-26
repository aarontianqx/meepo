import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run, Ticket } from '@meepo/core';
import type { WorkerStreamEvent } from '@meepo/protocol';

import { StreamProcessor } from '../stream-processor.js';
import { TicketService } from '../../tickets/ticket-service.js';
import { TranscriptService } from '../transcript-service.js';
import { MemoryRunRepository } from '../../../store/memory/run-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';

function makeSpace(id: string) {
  return {
    id,
    name: id,
    repoUrl: 'https://example.com/repo',
    defaultBranch: 'main',
    timezone: 'UTC',
    boundChatIds: [],
    requiredTags: [],
    longTermMemory: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeTicket(id: string, spaceId: string, workerId: string): Ticket {
  return {
    id,
    spaceId,
    title: id,
    objective: 'do it',
    requiredTags: [],
    status: 'running',
    assignedWorkerId: workerId,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeRun(id: string, work: Run['work']): Run {
  return {
    id,
    work,
    attempt: 1,
    status: 'dispatched',
    createdAt: 0,
  };
}

describe('StreamProcessor', () => {
  let events: MemorySessionEventRepository;
  let processor: StreamProcessor;
  let tickets: MemoryTicketRepository;
  let runs: MemoryRunRepository;

  beforeEach(async () => {
    events = new MemorySessionEventRepository();
    const sessions = new MemorySessionRepository();
    const spaces = new MemorySpaceRepository();
    tickets = new MemoryTicketRepository();
    runs = new MemoryRunRepository();
    await spaces.save(makeSpace('sp1'));
    const transcripts = new TranscriptService(events, sessions);
    processor = new StreamProcessor(transcripts, new TicketService(tickets, spaces), runs);
  });

  it('advances the run to running on run_started and appends the transcript on completion', async () => {
    await runs.save(makeRun('run1', { kind: 'turn', sessionId: 'se1' }));
    const send = (event: WorkerStreamEvent) => processor.onEvent(event);
    send({ type: 'run_started', runId: 'run1', workerId: 'w1', sessionId: 'se1' });
    send({ type: 'text_delta', runId: 'run1', delta: 'Hello ' });
    send({ type: 'text_delta', runId: 'run1', delta: 'world' });
    send({ type: 'run_completed', runId: 'run1' });

    await vi.waitFor(async () => {
      expect((await runs.getById('run1'))?.status).toBe('completed');
    });
    const run = await runs.getById('run1');
    expect(run?.workerId).toBe('w1');
    expect(run?.startedAt).toBeDefined();
    expect(run?.completedAt).toBeDefined();

    const records = await events.listBySession('se1');
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('message');
    expect(records[0].payload).toMatchObject({ role: 'assistant', content: 'Hello world' });
  });

  it('completes a ticket run with the buffered summary', async () => {
    await tickets.save(makeTicket('t1', 'sp1', 'w1'));
    await runs.save(makeRun('run2', { kind: 'ticket', ticketId: 't1' }));
    processor.onEvent({ type: 'run_started', runId: 'run2', workerId: 'w1', ticketId: 't1' });
    processor.onEvent({ type: 'text_delta', runId: 'run2', delta: 'PR opened' });
    processor.onEvent({ type: 'run_completed', runId: 'run2' });

    await vi.waitFor(async () => {
      expect((await tickets.getById('t1'))?.status).toBe('completed');
    });
    expect((await tickets.getById('t1'))?.result?.summary).toBe('PR opened');
    expect((await runs.getById('run2'))?.status).toBe('completed');
  });

  it('fails a ticket run on run_failed', async () => {
    await tickets.save(makeTicket('t2', 'sp1', 'w1'));
    await runs.save(makeRun('run3', { kind: 'ticket', ticketId: 't2' }));
    processor.onEvent({ type: 'run_started', runId: 'run3', workerId: 'w1', ticketId: 't2' });
    processor.onEvent({ type: 'run_failed', runId: 'run3', error: 'boom' });

    await vi.waitFor(async () => {
      expect((await tickets.getById('t2'))?.status).toBe('failed');
    });
    expect((await runs.getById('run3'))?.status).toBe('failed');
  });

  it('reports a ticket result back to its origin session', async () => {
    const origin: Ticket = { ...makeTicket('t9', 'sp1', 'w1'), originSessionId: 'se1' };
    await tickets.save(origin);
    await runs.save(makeRun('run9', { kind: 'ticket', ticketId: 't9' }));

    const notices: { sessionId: string; text: string }[] = [];
    processor.setTicketResultNotifier((sessionId, text) => {
      notices.push({ sessionId, text });
    });

    processor.onEvent({ type: 'run_started', runId: 'run9', workerId: 'w1', ticketId: 't9' });
    processor.onEvent({ type: 'text_delta', runId: 'run9', delta: 'shipped' });
    processor.onEvent({ type: 'run_completed', runId: 'run9' });

    await vi.waitFor(async () => {
      expect((await tickets.getById('t9'))?.status).toBe('completed');
    });

    const records = await events.listBySession('se1');
    expect(records).toHaveLength(1);
    expect(records[0].payload).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<ticket-result ticketId="t9" status="completed">'),
    });
    expect(records[0].payload).toMatchObject({ content: expect.stringContaining('shipped') });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ sessionId: 'se1' });
    expect(notices[0].text).toContain('已完成');
  });

  it('settles a turn from the persisted run even without a tracked ref', async () => {
    await runs.save(makeRun('run4', { kind: 'turn', sessionId: 'se7' }));
    processor.onEvent({ type: 'run_completed', runId: 'run4', resultSummary: 'done' });

    await vi.waitFor(async () => {
      expect((await runs.getById('run4'))?.status).toBe('completed');
    });
    const records = await events.listBySession('se7');
    expect(records).toHaveLength(1);
    expect(records[0].payload).toMatchObject({ role: 'assistant', content: 'done' });
  });

  it('notifies the render hook with the resolved work ref', async () => {
    const seen: string[] = [];
    processor.setRenderHook((event, ref) => {
      seen.push(`${event.type}:${ref.kind}`);
    });
    processor.onEvent({ type: 'run_started', runId: 'run5', workerId: 'w1', sessionId: 'se9' });
    processor.onEvent({ type: 'text_delta', runId: 'run5', delta: 'x' });
    await vi.waitFor(() => {
      expect(seen).toEqual(['run_started:session', 'text_delta:session']);
    });
  });
});
