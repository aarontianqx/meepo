import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Space, Session } from '@meepo/core';
import type { ScheduleView, TicketCreateResult } from '@meepo/protocol';

import type { DispatchService } from '../../../domain/dispatch/dispatch-service.js';
import { SchedulerService } from '../../../domain/schedule/scheduler-service.js';
import { SessionService } from '../../../domain/sessions/session-service.js';
import { StreamProcessor } from '../../../domain/sessions/stream-processor.js';
import { TranscriptService } from '../../../domain/sessions/transcript-service.js';
import { TicketService } from '../../../domain/tickets/ticket-service.js';
import type { WorkerService } from '../../../domain/workers/worker-service.js';
import { MemoryRunRepository } from '../../../store/memory/run-memory.js';
import { MemoryScheduleRepository } from '../../../store/memory/schedule-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';
import { MemoryService } from '../../../domain/memory/memory-service.js';
import { SqliteMemoryRepository } from '../../../store/sqlite/memory-sqlite.js';
import { openDatabase } from '../../../store/sqlite/database.js';
import { WorkerChannelHandler, type WorkerChannelDeps } from '../worker-channel.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

class FakeSocket {
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (raw: Buffer) => void>();

  on(event: string, handler: (raw: Buffer) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  once(): this {
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  receive(frame: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(frame)));
  }

  async nextResponse(): Promise<{ id: string; result?: unknown; error?: { code: string } }> {
    await vi.waitFor(() => {
      expect(this.sent.length).toBeGreaterThan(0);
    });
    return JSON.parse(this.sent.shift()!) as { id: string; result?: unknown };
  }
}

function makeSpace(id: string): Space {
  return {
    id,
    name: id,
    repoUrl: 'https://example.com/repo',
    defaultBranch: 'main',
    timezone: 'Asia/Shanghai',
    boundChatIds: [],
    requiredTags: [],
    longTermMemory: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSession(id: string, spaceId: string): Session {
  return {
    id,
    spaceId,
    kind: 'thread',
    boundWorkerId: 'w1',
    chatId: 'chat',
    threadId: 'thread',
    status: 'active',
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

describe('WorkerChannelHandler scheduling tools', () => {
  let deps: WorkerChannelDeps;
  let socket: FakeSocket;
  let handler: WorkerChannelHandler;
  let tickets: MemoryTicketRepository;
  let schedules: MemoryScheduleRepository;
  let schedulerService: SchedulerService;
  let dispatchTicket: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const spaces = new MemorySpaceRepository();
    const sessions = new MemorySessionRepository();
    tickets = new MemoryTicketRepository();
    schedules = new MemoryScheduleRepository();
    await spaces.save(makeSpace('sp1'));
    await sessions.save(makeSession('se1', 'sp1'));

    const sessionService = new SessionService(sessions, spaces);
    const ticketService = new TicketService(tickets, spaces);
    schedulerService = new SchedulerService(schedules, sessions, spaces);
    const transcriptService = new TranscriptService(new MemorySessionEventRepository(), sessions);
    const streamProcessor = new StreamProcessor(
      transcriptService,
      ticketService,
      new MemoryRunRepository()
    );

    dispatchTicket = vi.fn().mockResolvedValue({ dispatched: true, queued: false });
    deps = {
      dispatchService: { dispatchTicket } as unknown as DispatchService,
      workerService: {
        register: async () => ({ workerId: 'w1', spaceIds: ['sp1'], heartbeatIntervalSeconds: 15 }),
        getWorker: async () => ({ id: 'w1', spaceIds: ['sp1'] }),
      } as unknown as WorkerService,
      schedulerService,
      sessionService,
      ticketService,
      transcriptService,
      streamProcessor,
    };
    handler = new WorkerChannelHandler(deps);

    socket = new FakeSocket();
    handler.handleConnection(socket as never);
    socket.receive({ kind: 'request', id: 'register', method: 'worker.register', params: {} });
    await socket.nextResponse();
  });

  it('attributes schedules and memory to the persisted initiator, with agent fallback', async () => {
    const db = openDatabase(':memory:');
    try {
      const runs = new MemoryRunRepository();
      deps.runRepository = runs;
      deps.memoryService = new MemoryService(new SqliteMemoryRepository(db));
      for (const initiatorIds of [['user-1', 'user-2'], []]) {
        await runs.save({
          id: 'r1',
          work: { kind: 'turn', turnRef: { sessionId: 'se1', sourceId: 'm' } },
          attempt: 1,
          status: 'running',
          workerId: 'w1',
          createdAt: Date.now(),
          leaseExpiresAt: Date.now() + 60000,
          initiatorIds,
        });
        socket.receive({
          kind: 'request',
          id: 'schedule',
          method: 'cron.create',
          params: {
            sessionId: 'se1',
            runId: 'r1',
            prompt: 'attribution',
            timing: { kind: 'at', at: Date.now() + 60000 },
            createdByUserId: 'forged',
          },
        });
        const response = await socket.nextResponse();
        expect(response.error).toBeUndefined();
        const saved = await schedules.getById((response.result as ScheduleView).id);
        expect(saved?.createdByUserId).toBe(initiatorIds[0] ?? 'agent');
        const path = initiatorIds.length ? 'user' : 'machine';
        socket.receive({
          kind: 'request',
          id: 'memory',
          method: 'memory.call',
          params: {
            sessionId: 'se1',
            runId: 'r1',
            operation: 'write',
            input: {
              path,
              description: 'attribution',
              content: 'value',
              expected_revision: 0,
              authorId: 'forged',
            },
          },
        });
        const memory = await socket.nextResponse();
        expect(memory.error).toBeUndefined();
        expect(deps.memoryService.read('sp1', path).updatedBy).toEqual({
          kind: 'agent',
          sessionId: 'se1',
          authorId: initiatorIds[0],
        });
      }
    } finally {
      db.close();
    }
  });

  describe('ticket.create', () => {
    it('creates and dispatches a ticket immediately when no timing is given', async () => {
      socket.receive({
        kind: 'request',
        id: '1',
        method: 'ticket.create',
        params: { sessionId: 'se1', objective: 'write the report' },
      });
      const response = await socket.nextResponse();

      const result = response.result as TicketCreateResult;
      expect(result.kind).toBe('ticket');
      if (result.kind !== 'ticket') throw new Error('expected ticket result');
      expect(result.ticket).toMatchObject({ objective: 'write the report', status: 'pending' });

      const ticket = await tickets.getById(result.ticket.id);
      expect(ticket).toMatchObject({ spaceId: 'sp1', originSessionId: 'se1' });
      expect(dispatchTicket).toHaveBeenCalledWith(result.ticket.id);
      expect(await schedules.list()).toHaveLength(0);
    });

    it('creates a create_ticket schedule when timing is given', async () => {
      socket.receive({
        kind: 'request',
        id: '2',
        method: 'ticket.create',
        params: {
          sessionId: 'se1',
          objective: 'nightly audit',
          contextSummary: 'see last run',
          timing: { kind: 'cron', expression: '0 9 * * *' },
        },
      });
      const response = await socket.nextResponse();

      const result = response.result as TicketCreateResult;
      expect(result.kind).toBe('schedule');
      if (result.kind !== 'schedule') throw new Error('expected schedule result');
      expect(result.schedule).toMatchObject({
        action: 'create_ticket',
        objective: 'nightly audit',
        timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      });
      expect(result.schedule.nextFireAt).toBeGreaterThan(Date.now());

      const saved = await schedules.getById(result.schedule.id);
      expect(saved?.action).toMatchObject({ kind: 'create_ticket', originSessionId: 'se1' });
      expect(dispatchTicket).not.toHaveBeenCalled();
      expect(await tickets.list()).toHaveLength(0);
    });

    it('rejects an unknown session', async () => {
      socket.receive({
        kind: 'request',
        id: '3',
        method: 'ticket.create',
        params: { sessionId: 'ghost', objective: 'x' },
      });
      const response = await socket.nextResponse();
      expect(response.error?.code).toBe('not_found');
    });
  });

  describe('cron.*', () => {
    it('creates, lists, and deletes a resume_session schedule', async () => {
      socket.receive({
        kind: 'request',
        id: '10',
        method: 'cron.create',
        params: {
          sessionId: 'se1',
          prompt: 'standup',
          timing: { kind: 'cron', expression: '0 9 * * *' },
        },
      });
      const created = await socket.nextResponse();
      const view = created.result as ScheduleView;
      expect(view).toMatchObject({ action: 'resume_session', prompt: 'standup' });
      expect(view.nextFireAt).toBeGreaterThan(Date.now());

      socket.receive({
        kind: 'request',
        id: '11',
        method: 'cron.list',
        params: { sessionId: 'se1' },
      });
      const listed = await socket.nextResponse();
      expect((listed.result as ScheduleView[]).map((item) => item.id)).toEqual([view.id]);

      socket.receive({
        kind: 'request',
        id: '12',
        method: 'cron.delete',
        params: { sessionId: 'se1', scheduleId: view.id },
      });
      const deleted = await socket.nextResponse();
      expect(deleted.result).toEqual({ deleted: true });

      socket.receive({
        kind: 'request',
        id: '13',
        method: 'cron.list',
        params: { sessionId: 'se1' },
      });
      const relisted = await socket.nextResponse();
      expect(relisted.result).toEqual([]);
    });

    it('scopes cron.delete to the owning session', async () => {
      socket.receive({
        kind: 'request',
        id: '20',
        method: 'cron.create',
        params: { sessionId: 'se1', prompt: 'standup', timing: { kind: 'at', at: NOW + 60_000 } },
      });
      const created = await socket.nextResponse();
      const view = created.result as ScheduleView;

      socket.receive({
        kind: 'request',
        id: '21',
        method: 'cron.delete',
        params: { sessionId: 'other', scheduleId: view.id },
      });
      const response = await socket.nextResponse();
      expect(response.error?.code).toBe('not_found');
    });
  });
});
