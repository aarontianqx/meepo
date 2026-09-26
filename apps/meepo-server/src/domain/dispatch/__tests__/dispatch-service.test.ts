import { beforeEach, describe, expect, it } from 'vitest';

import type { Session, Space, Ticket, WorkerNode } from '@meepo/core';
import type { TurnDispatchEnvelope, WorkerChannelDownstream } from '@meepo/protocol';

import { DispatchService } from '../dispatch-service.js';
import { DomainError } from '../../errors.js';
import { MemoryDispatchQueueRepository } from '../../../store/memory/dispatch-queue-memory.js';
import { MemoryRunRepository } from '../../../store/memory/run-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';
import { MemoryWorkerRepository } from '../../../store/memory/worker-memory.js';
import { TranscriptService } from '../../sessions/transcript-service.js';
import type { WorkerSender } from '../worker-sender.js';

const MODEL_ENTRY = {
  id: 'm',
  provider: 'openai-completions',
  baseUrl: 'https://x',
  apiKey: 'k',
  model: 'm',
};
const MODEL = { modelId: 'm' };

class FakeSender implements WorkerSender {
  readonly connected = new Set<string>();
  readonly sent: { workerId: string; frame: WorkerChannelDownstream }[] = [];

  isConnected(workerId: string): boolean {
    return this.connected.has(workerId);
  }

  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void {
    this.sent.push({ workerId, frame });
  }
}

function makeSpace(id: string, boundWorkerId?: string): Space {
  return {
    id,
    name: id,
    repoUrl: 'https://example.com/repo',
    defaultBranch: 'main',
    timezone: 'UTC',
    model: MODEL,
    boundWorkerId,
    boundChatIds: [],
    requiredTags: [],
    longTermMemory: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeWorker(id: string, spaceIds: string[], overrides?: Partial<WorkerNode>): WorkerNode {
  return {
    id,
    spaceIds,
    hostname: id,
    tags: [],
    maxSlots: 2,
    activeSlots: 0,
    status: 'online',
    lastHeartbeatAt: 0,
    version: '0',
    ...overrides,
  };
}

function makeSession(id: string, spaceId: string, kind: Session['kind']): Session {
  return {
    id,
    spaceId,
    kind,
    chatId: 'chat',
    threadId: 'thread',
    status: 'active',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function makeTicket(id: string, spaceId: string): Ticket {
  return {
    id,
    spaceId,
    title: id,
    objective: 'do it',
    requiredTags: [],
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('DispatchService', () => {
  let sessions: MemorySessionRepository;
  let spaces: MemorySpaceRepository;
  let workers: MemoryWorkerRepository;
  let tickets: MemoryTicketRepository;
  let runs: MemoryRunRepository;
  let queue: MemoryDispatchQueueRepository;
  let sender: FakeSender;
  let service: DispatchService;

  beforeEach(() => {
    sessions = new MemorySessionRepository();
    spaces = new MemorySpaceRepository();
    workers = new MemoryWorkerRepository();
    tickets = new MemoryTicketRepository();
    runs = new MemoryRunRepository();
    queue = new MemoryDispatchQueueRepository();
    sender = new FakeSender();
    const transcripts = new TranscriptService(new MemorySessionEventRepository(), sessions);
    service = new DispatchService(
      sessions,
      spaces,
      workers,
      tickets,
      runs,
      queue,
      sender,
      transcripts,
      {
        entries: [MODEL_ENTRY],
        defaultModelId: 'm',
      }
    );
  });

  const turn = {
    prompt: 'hi',
    source: { kind: 'user_message', messageId: 'm1' } as const,
    delivery: 'wait' as const,
  };

  it('rejects a main session when the space has no bound worker', async () => {
    await spaces.save(makeSpace('sp1'));
    await sessions.save(makeSession('se1', 'sp1', 'main'));
    await expect(service.dispatchSessionTurn({ sessionId: 'se1', ...turn })).rejects.toThrow(
      DomainError
    );
  });

  it('routes a main session to the space bound worker and records a run', async () => {
    await spaces.save(makeSpace('sp1', 'w1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'main'));
    sender.connected.add('w1');

    const outcome = await service.dispatchSessionTurn({ sessionId: 'se1', ...turn });
    expect(outcome).toMatchObject({ dispatched: true, queued: false, workerId: 'w1' });
    const frame = sender.sent[0].frame;
    if (frame.kind !== 'notification' || frame.event !== 'turn.dispatch') {
      throw new Error('expected turn.dispatch');
    }
    const envelope = frame.payload as TurnDispatchEnvelope;
    expect(envelope.sessionKind).toBe('main');

    const run = await runs.getById(envelope.runId);
    expect(run).toMatchObject({
      work: { kind: 'turn', sessionId: 'se1' },
      attempt: 1,
      workerId: 'w1',
      status: 'dispatched',
    });
  });

  it('pins a thread session to its dispatch target across turns', async () => {
    await spaces.save(makeSpace('sp1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'thread'));
    sender.connected.add('w1');

    await service.dispatchSessionTurn({ sessionId: 'se1', ...turn });
    const first = (await sessions.getById('se1'))?.boundWorkerId;
    expect(first).toBe('w1');

    sender.connected.delete('w1');
    const outcome = await service.dispatchSessionTurn({ sessionId: 'se1', ...turn });
    expect(outcome).toMatchObject({ dispatched: false, queued: true, workerId: 'w1' });
  });

  it('queues turns for an offline bound worker and flushes coalesced on reconnect', async () => {
    await spaces.save(makeSpace('sp1', 'w1'));
    await workers.save(makeWorker('w1', ['sp1'], { status: 'offline' }));
    await sessions.save(makeSession('se1', 'sp1', 'main'));

    await service.dispatchSessionTurn({ sessionId: 'se1', ...turn });
    await service.dispatchSessionTurn({ sessionId: 'se1', ...turn, prompt: 'second' });
    const queued = await queue.listBySession('se1');
    expect(queued).toHaveLength(2);
    for (const item of queued) {
      expect((await runs.getById(item.envelope.runId))?.status).toBe('queued');
    }

    sender.connected.add('w1');
    const flushed = await service.flushWorkerQueues('w1');
    expect(flushed).toBe(2);
    expect((await queue.listBySession('se1')).length).toBe(0);
    const frame = sender.sent[sender.sent.length - 1].frame;
    if (frame.kind !== 'notification') throw new Error('expected notification');
    const envelope = frame.payload as TurnDispatchEnvelope;
    expect(envelope.prompt).toContain('hi');
    expect(envelope.prompt).toContain('second');
    for (const item of queued) {
      expect((await runs.getById(item.envelope.runId))?.status).toBe('dispatched');
    }
  });

  it('dispatches a ticket to the least-loaded eligible worker and claims it', async () => {
    await spaces.save(makeSpace('sp1'));
    await workers.save(makeWorker('w1', ['sp1'], { activeSlots: 1 }));
    await workers.save(makeWorker('w2', ['sp1']));
    await tickets.save(makeTicket('t1', 'sp1'));
    sender.connected.add('w1').add('w2');

    const outcome = await service.dispatchTicket('t1');
    expect(outcome).toMatchObject({ dispatched: true, workerId: 'w2' });
    const ticket = await tickets.getById('t1');
    expect(ticket?.status).toBe('claimed');
    expect(ticket?.assignedWorkerId).toBe('w2');

    const frame = sender.sent[0].frame;
    if (frame.kind !== 'notification' || frame.event !== 'ticket.dispatch') {
      throw new Error('expected ticket.dispatch');
    }
    const run = await runs.getById((frame.payload as { runId: string }).runId);
    expect(run).toMatchObject({
      work: { kind: 'ticket', ticketId: 't1' },
      attempt: 1,
      workerId: 'w2',
      status: 'dispatched',
    });
  });

  it('increments the run attempt on ticket redispatch', async () => {
    await spaces.save(makeSpace('sp1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await tickets.save(makeTicket('t1', 'sp1'));
    sender.connected.add('w1');

    await service.dispatchTicket('t1');
    const ticket = await tickets.getById('t1');
    await tickets.save({ ...ticket!, status: 'pending', assignedWorkerId: undefined });

    await service.dispatchTicket('t1');
    const ticketRuns = await runs.listByTicket('t1');
    expect(ticketRuns).toHaveLength(2);
    expect(ticketRuns.map((run) => run.attempt)).toEqual([1, 2]);
    expect(await runs.latestAttempt('t1')).toBe(2);
  });

  it('leaves a ticket pending without a run when no worker is eligible', async () => {
    await spaces.save(makeSpace('sp1'));
    await tickets.save(makeTicket('t1', 'sp1'));
    const outcome = await service.dispatchTicket('t1');
    expect(outcome.dispatched).toBe(false);
    expect((await tickets.getById('t1'))?.status).toBe('pending');
    expect(await runs.listByTicket('t1')).toHaveLength(0);
  });

  it('retries pending tickets once a worker becomes eligible', async () => {
    await spaces.save(makeSpace('sp1'));
    await tickets.save(makeTicket('t1', 'sp1'));
    expect(await service.dispatchPendingTickets()).toBe(0);

    await workers.save(makeWorker('w1', ['sp1']));
    sender.connected.add('w1');
    expect(await service.dispatchPendingTickets()).toBe(1);
    expect((await tickets.getById('t1'))?.status).toBe('claimed');
  });

  it('rejects dispatch when no model is configured', async () => {
    await spaces.save({ ...makeSpace('sp1', 'w1'), model: undefined });
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'main'));
    sender.connected.add('w1');
    const noModel = new DispatchService(
      sessions,
      spaces,
      workers,
      tickets,
      runs,
      queue,
      sender,
      new TranscriptService(new MemorySessionEventRepository(), sessions),
      { entries: [] }
    );
    await expect(noModel.dispatchSessionTurn({ sessionId: 'se1', ...turn })).rejects.toThrow(
      DomainError
    );
  });
});
