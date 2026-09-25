import { beforeEach, describe, expect, it } from 'vitest';

import type { Session, Space, Ticket, WorkerNode } from '@meepo/core';
import type { SessionDispatchEnvelope, WorkerChannelDownstream } from '@meepo/protocol';

import { DispatchService } from '../dispatch-service.js';
import { DomainError } from '../../errors.js';
import { MemoryDispatchQueueRepository } from '../../../store/memory/dispatch-queue-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';
import { MemoryWorkerRepository } from '../../../store/memory/worker-memory.js';
import { TranscriptService } from '../../sessions/transcript-service.js';
import type { WorkerSender } from '../worker-sender.js';

const MODEL = { provider: 'openai-completions', baseUrl: 'https://x', apiKey: 'k', model: 'm' };

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
  let queue: MemoryDispatchQueueRepository;
  let sender: FakeSender;
  let service: DispatchService;

  beforeEach(() => {
    sessions = new MemorySessionRepository();
    spaces = new MemorySpaceRepository();
    workers = new MemoryWorkerRepository();
    tickets = new MemoryTicketRepository();
    queue = new MemoryDispatchQueueRepository();
    sender = new FakeSender();
    const transcripts = new TranscriptService(new MemorySessionEventRepository(), sessions);
    service = new DispatchService(sessions, spaces, workers, tickets, queue, sender, transcripts);
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

  it('routes a main session to the space bound worker', async () => {
    await spaces.save(makeSpace('sp1', 'w1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'main'));
    sender.connected.add('w1');

    const outcome = await service.dispatchSessionTurn({ sessionId: 'se1', ...turn });
    expect(outcome).toMatchObject({ dispatched: true, queued: false, workerId: 'w1' });
    const frame = sender.sent[0].frame;
    if (frame.kind !== 'notification' || frame.event !== 'session.dispatch') {
      throw new Error('expected session.dispatch');
    }
    const envelope = frame.payload as SessionDispatchEnvelope;
    expect(envelope.sessionKind).toBe('main');
    expect(envelope.workspace).toBeNull();
  });

  it('pins a task session to its dispatch target across turns', async () => {
    await spaces.save(makeSpace('sp1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'task'));
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
    expect((await queue.listBySession('se1')).length).toBe(2);

    sender.connected.add('w1');
    const flushed = await service.flushWorkerQueues('w1');
    expect(flushed).toBe(2);
    expect((await queue.listBySession('se1')).length).toBe(0);
    const frame = sender.sent[sender.sent.length - 1].frame;
    if (frame.kind !== 'notification') throw new Error('expected notification');
    const envelope = frame.payload as SessionDispatchEnvelope;
    expect(envelope.prompt).toContain('hi');
    expect(envelope.prompt).toContain('second');
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
  });

  it('leaves a ticket pending when no worker is eligible', async () => {
    await spaces.save(makeSpace('sp1'));
    await tickets.save(makeTicket('t1', 'sp1'));
    const outcome = await service.dispatchTicket('t1');
    expect(outcome.dispatched).toBe(false);
    expect((await tickets.getById('t1'))?.status).toBe('pending');
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

  it('prefers the ticket workspace binding over the space default repo', async () => {
    await spaces.save(makeSpace('sp1'));
    await workers.save(makeWorker('w1', ['sp1']));
    await tickets.save({
      ...makeTicket('t1', 'sp1'),
      workspace: { repoUrl: 'git@example.com:other/repo.git', branch: 'dev' },
    });
    sender.connected.add('w1');

    await service.dispatchTicket('t1');
    const frame = sender.sent[0].frame;
    if (frame.kind !== 'notification' || frame.event !== 'ticket.dispatch') {
      throw new Error('expected ticket.dispatch');
    }
    expect(frame.payload.workspace).toEqual({
      repoUrl: 'git@example.com:other/repo.git',
      branch: 'dev',
    });
  });

  it('rejects dispatch when no model is configured', async () => {
    await spaces.save({ ...makeSpace('sp1', 'w1'), model: undefined });
    await workers.save(makeWorker('w1', ['sp1']));
    await sessions.save(makeSession('se1', 'sp1', 'main'));
    sender.connected.add('w1');
    await expect(service.dispatchSessionTurn({ sessionId: 'se1', ...turn })).rejects.toThrow(
      DomainError
    );
  });
});
