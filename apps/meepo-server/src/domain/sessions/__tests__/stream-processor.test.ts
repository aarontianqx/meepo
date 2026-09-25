import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from '@meepo/core';
import type { WorkerStreamEvent } from '@meepo/protocol';

import { StreamProcessor } from '../stream-processor.js';
import { TicketService } from '../../tickets/ticket-service.js';
import { TranscriptService } from '../transcript-service.js';
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

describe('StreamProcessor', () => {
  let events: MemorySessionEventRepository;
  let processor: StreamProcessor;
  let tickets: MemoryTicketRepository;

  beforeEach(async () => {
    events = new MemorySessionEventRepository();
    const sessions = new MemorySessionRepository();
    const spaces = new MemorySpaceRepository();
    tickets = new MemoryTicketRepository();
    await spaces.save(makeSpace('sp1'));
    const transcripts = new TranscriptService(events, sessions);
    processor = new StreamProcessor(transcripts, new TicketService(tickets, spaces));
  });

  it('accumulates session text and appends the assistant message on completion', async () => {
    const send = (event: WorkerStreamEvent) => processor.onEvent(event);
    send({ type: 'task_started', taskId: 'task1', workerId: 'w1', sessionId: 'se1' });
    send({ type: 'text_delta', taskId: 'task1', delta: 'Hello ' });
    send({ type: 'text_delta', taskId: 'task1', delta: 'world' });
    send({ type: 'task_completed', taskId: 'task1' });

    await vi.waitFor(async () => {
      const records = await events.listBySession('se1');
      expect(records).toHaveLength(1);
    });
    const records = await events.listBySession('se1');
    expect(records[0].type).toBe('message');
    expect(records[0].payload).toMatchObject({ role: 'assistant', content: 'Hello world' });
  });

  it('completes a ticket with the buffered summary', async () => {
    await tickets.save(makeTicket('t1', 'sp1', 'w1'));
    processor.onEvent({ type: 'task_started', taskId: 'task2', workerId: 'w1', ticketId: 't1' });
    processor.onEvent({ type: 'text_delta', taskId: 'task2', delta: 'PR opened' });
    processor.onEvent({ type: 'task_completed', taskId: 'task2' });

    await vi.waitFor(async () => {
      expect((await tickets.getById('t1'))?.status).toBe('completed');
    });
    expect((await tickets.getById('t1'))?.result?.summary).toBe('PR opened');
  });

  it('fails a ticket on task_failed', async () => {
    await tickets.save(makeTicket('t2', 'sp1', 'w1'));
    processor.onEvent({ type: 'task_started', taskId: 'task3', workerId: 'w1', ticketId: 't2' });
    processor.onEvent({ type: 'task_failed', taskId: 'task3', error: 'boom' });

    await vi.waitFor(async () => {
      expect((await tickets.getById('t2'))?.status).toBe('failed');
    });
  });

  it('notifies the render hook with the resolved task ref', async () => {
    const seen: string[] = [];
    processor.setRenderHook((event, ref) => {
      seen.push(`${event.type}:${ref.kind}`);
    });
    processor.onEvent({ type: 'task_started', taskId: 'task4', workerId: 'w1', sessionId: 'se9' });
    processor.onEvent({ type: 'text_delta', taskId: 'task4', delta: 'x' });
    expect(seen).toEqual(['task_started:session', 'text_delta:session']);
  });
});
