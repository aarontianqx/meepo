import type { RunRepository } from '../../domain/runs/run-repository.js';
import type { PromptService } from '../../domain/prompts/prompt-service.js';
import {
  MemoryError,
  type MemoryService,
  type MemoryWriteInput,
} from '../../domain/memory/memory-service.js';
import type WebSocket from 'ws';
import { WorkerConnectionHub } from './worker-connection-hub.js';

import {
  RPC_ERROR_CODES,
  type SequencedWorkerEvent,
  type ReconcileParams,
  SERVER_CHANNEL_EVENTS,
  WORKER_CHANNEL_METHODS,
  type CronCreateParams,
  type CronDeleteParams,
  type CronListParams,
  type RpcFrame,
  type RpcRequest,
  type RpcResponse,
  type SessionSnapshotParams,
  type TicketCreateParams,
  type TicketCreateResult,
  type WorkerChannelDownstream,
  type WorkerHeartbeatPayload,
  type WorkerRegisterPayload,
} from '@meepo/protocol';

import type { DispatchService } from '../../domain/dispatch/dispatch-service.js';
import type { WorkerSender } from '../../domain/dispatch/worker-sender.js';
import { DomainError, validation, unauthorized } from '../../domain/errors.js';
import type { SchedulerService } from '../../domain/schedule/scheduler-service.js';
import type { SessionService } from '../../domain/sessions/session-service.js';
import type { StreamProcessor } from '../../domain/sessions/stream-processor.js';
import type { TranscriptService } from '../../domain/sessions/transcript-service.js';
import type { TicketService } from '../../domain/tickets/ticket-service.js';
import type { WorkerService } from '../../domain/workers/worker-service.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

const DOMAIN_TO_RPC_CODE: Record<DomainError['code'], string> = {
  not_found: RPC_ERROR_CODES.notFound,
  validation: RPC_ERROR_CODES.invalidParams,
  conflict: RPC_ERROR_CODES.invalidParams,
  unauthorized: RPC_ERROR_CODES.unauthorized,
};

export interface WorkerChannelDeps {
  runRepository?: RunRepository;
  workerService: WorkerService;
  schedulerService: SchedulerService;
  sessionService: SessionService;
  ticketService: TicketService;
  transcriptService: TranscriptService;
  streamProcessor: StreamProcessor;
  promptService?: PromptService;
  memoryService?: MemoryService;
  connections?: WorkerConnectionHub;
  dispatchService?: DispatchService;
  onWorkerReady?: (workerId: string) => void;
}

/**
 * Handles the persistent worker WebSocket channel: registration, heartbeats,
 * session snapshots, scheduling tool proxying (cron.*, ticket.create), and
 * stream event ingestion. Also implements the WorkerSender port used by the
 * dispatch pipeline.
 */
export class WorkerChannelHandler implements WorkerSender {
  private readonly identities = new WeakMap<WebSocket, string>();
  private readonly connections: WorkerConnectionHub;

  constructor(
    private readonly deps: WorkerChannelDeps,
    private readonly logger: Logger = console
  ) {
    this.connections = deps.connections ?? new WorkerConnectionHub();
  }

  isConnected(workerId: string): boolean {
    return this.connections.isConnected(workerId);
  }
  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void {
    this.connections.sendToWorker(workerId, frame);
  }

  handleConnection(socket: WebSocket): void {
    socket.on('message', (raw: Buffer) => {
      void this.onFrame(socket, raw).catch((err: unknown) => {
        this.logger.error('worker channel frame handling failed', err);
      });
    });
  }

  private async onFrame(socket: WebSocket, raw: Buffer): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) {
      this.send(socket, {
        kind: 'response',
        id: 'unknown',
        error: { code: RPC_ERROR_CODES.invalidFrame, message: 'Frame is not valid JSON-RPC' },
      });
      return;
    }
    if (frame.kind === 'request') {
      await this.onRequest(socket, frame);
      return;
    }
    if (frame.kind === 'notification' && frame.event === SERVER_CHANNEL_EVENTS.stream) {
      this.logger.warn('unacknowledged stream notifications are unsupported; use stream.append');
    }
  }

  private async onRequest(socket: WebSocket, frame: RpcRequest): Promise<void> {
    try {
      const workerId = this.identities.get(socket);
      let authorId: string | undefined;
      if (frame.method !== WORKER_CHANNEL_METHODS.register) {
        if (!workerId || this.connections.get(workerId) !== socket)
          throw unauthorized('Worker must register first');
        await this.deps.workerService.assertAuthorized?.(workerId);
        const params = frame.params as {
          sessionId?: string;
          ticketId?: string;
          workerId?: string;
          runId?: string;
        };
        if (
          this.deps.runRepository &&
          [
            WORKER_CHANNEL_METHODS.memory,
            WORKER_CHANNEL_METHODS.cronCreate,
            WORKER_CHANNEL_METHODS.cronDelete,
            WORKER_CHANNEL_METHODS.ticketCreate,
          ].some((method) => method === frame.method)
        ) {
          const run = params.runId
            ? await this.deps.runRepository.getById(params.runId)
            : undefined;
          if (
            !run ||
            run.workerId !== workerId ||
            run.status !== 'running' ||
            !run.leaseExpiresAt ||
            run.leaseExpiresAt <= Date.now()
          )
            throw unauthorized('Tool execution lease is invalid');
          if (
            (run.work.kind === 'turn' && run.work.turnRef.sessionId !== params.sessionId) ||
            (run.work.kind === 'ticket' && run.work.ticketId !== params.ticketId)
          )
            throw unauthorized('Tool resource does not match its run');
          authorId = run.initiatorIds?.[0];
        }
        if (params.workerId && params.workerId !== workerId)
          throw unauthorized('Worker identity mismatch');
        if (params.sessionId) {
          const session = await this.deps.sessionService.getSession(params.sessionId);
          const worker = await this.deps.workerService.getWorker(workerId);
          if (!worker.spaceIds.includes(session.spaceId) || session.boundWorkerId !== workerId)
            throw unauthorized('Session belongs to another worker');
        }
      }
      switch (frame.method) {
        case WORKER_CHANNEL_METHODS.register:
          await this.onRegister(socket, frame);
          return;
        case WORKER_CHANNEL_METHODS.streamAppend: {
          const result = await this.deps.streamProcessor.acceptEvent(
            workerId!,
            frame.params as SequencedWorkerEvent
          );
          this.send(socket, { kind: 'response', id: frame.id, result });
          return;
        }
        case WORKER_CHANNEL_METHODS.reconcile: {
          const result = await this.deps.streamProcessor.reconcile(
            workerId!,
            frame.params as ReconcileParams
          );
          this.send(socket, { kind: 'response', id: frame.id, result });

          return;
        }
        case WORKER_CHANNEL_METHODS.promptRecord: {
          const p = frame.params as { sessionId: string; snapshot: unknown };
          if (!p.sessionId || JSON.stringify(p.snapshot).length > 256_000)
            throw validation('Invalid prompt snapshot');
          await this.deps.transcriptService.appendEvent(p.sessionId, 'prompt_snapshot', p.snapshot);
          this.send(socket, { kind: 'response', id: frame.id, result: { recorded: true } });
          return;
        }
        case WORKER_CHANNEL_METHODS.promptPrepare:
        case WORKER_CHANNEL_METHODS.memory: {
          const p = frame.params as {
            sessionId?: string;
            ticketId?: string;
            operation: string;
            input: Record<string, unknown>;
          };
          const resource = p.sessionId
            ? await this.deps.sessionService.getSession(p.sessionId)
            : p.ticketId
              ? await this.deps.ticketService.getTicket(p.ticketId)
              : undefined;
          const worker = await this.deps.workerService.getWorker(workerId!);
          if (!resource || !worker.spaceIds.includes(resource.spaceId))
            throw unauthorized('Memory belongs to another space');
          if (
            p.ticketId &&
            'assignedWorkerId' in resource &&
            resource.assignedWorkerId !== workerId
          )
            throw unauthorized('Ticket belongs to another worker');
          if (frame.method === WORKER_CHANNEL_METHODS.promptPrepare) {
            const result = await this.deps.promptService?.prepare(resource.spaceId, p.sessionId);
            this.send(socket, { kind: 'response', id: frame.id, result });
            return;
          }
          const memory = this.deps.memoryService;
          if (!memory) throw validation('Memory is unavailable');
          const input = p.input ?? {};
          const spaceId = resource.spaceId;
          let result: unknown;
          switch (p.operation) {
            case 'map':
              result = memory.map(spaceId);
              break;
            case 'list':
              result = memory.list(
                spaceId,
                input.prefix as string | undefined,
                input.limit as number | undefined
              );
              break;
            case 'search':
              result = memory.search(
                spaceId,
                input.query as string,
                input.prefix as string | undefined,
                input.limit as number | undefined
              );
              break;
            case 'read':
              result = memory.read(spaceId, input.path as string, input);
              break;
            case 'write':
              result = memory.write(spaceId, input as unknown as MemoryWriteInput, {
                kind: 'agent',
                sessionId: p.sessionId ?? `ticket:${p.ticketId}`,
                authorId,
              });
              break;
            case 'delete':
              result = memory.delete(
                spaceId,
                input.path as string,
                input.expected_revision as number
              );
              break;
            default:
              throw validation('Unknown memory operation');
          }
          this.send(socket, { kind: 'response', id: frame.id, result });
          return;
        }
        case WORKER_CHANNEL_METHODS.ready:
          this.send(socket, { kind: 'response', id: frame.id, result: { accepted: true } });
          this.deps.onWorkerReady?.(workerId!);
          return;
        case WORKER_CHANNEL_METHODS.heartbeat: {
          const params = frame.params as WorkerHeartbeatPayload;
          await this.deps.workerService.heartbeat(params.workerId, params);
          await this.deps.streamProcessor.renewLeases(
            params.workerId,
            params.activeRunIds,
            this.deps.workerService.leaseDurationMs
          );
          this.send(socket, { kind: 'response', id: frame.id, result: { accepted: true } });
          return;
        }
        case WORKER_CHANNEL_METHODS.sessionSnapshot: {
          const params = frame.params as SessionSnapshotParams;
          const snapshot = await this.deps.transcriptService.getSnapshot(
            params.sessionId,
            params.beforeTimestamp,
            params.beforeSeq
          );
          this.send(socket, { kind: 'response', id: frame.id, result: snapshot });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronCreate: {
          const view = await this.onCronCreate(frame.params as CronCreateParams, authorId);
          this.send(socket, { kind: 'response', id: frame.id, result: view });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronList: {
          const views = await this.deps.schedulerService.listSessionSchedules(
            (frame.params as CronListParams).sessionId
          );
          this.send(socket, { kind: 'response', id: frame.id, result: views });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronDelete: {
          const params = frame.params as CronDeleteParams;
          await this.deps.schedulerService.deleteSessionSchedule(
            params.sessionId,
            params.scheduleId
          );
          this.send(socket, { kind: 'response', id: frame.id, result: { deleted: true } });
          return;
        }
        case WORKER_CHANNEL_METHODS.ticketCreate: {
          const result = await this.onTicketCreate(frame.params as TicketCreateParams, authorId);
          this.send(socket, { kind: 'response', id: frame.id, result });
          return;
        }
        default:
          this.send(socket, {
            kind: 'response',
            id: frame.id,
            error: {
              code: RPC_ERROR_CODES.unknownMethod,
              message: `Unknown method: ${frame.method}`,
            },
          });
      }
    } catch (err) {
      this.send(socket, { kind: 'response', id: frame.id, error: toRpcError(err) });
    }
  }

  /** cron.create: schedule a wakeup (`resume_session`) for the calling session. */
  private async onCronCreate(params: CronCreateParams, authorId?: string) {
    const session = await this.deps.sessionService.getSession(params.sessionId);
    const schedule = await this.deps.schedulerService.createSchedule(
      {
        spaceId: session.spaceId,
        timing: params.timing,
        action: { kind: 'resume_session', sessionId: session.id, prompt: params.prompt },
      },
      authorId ?? 'agent'
    );
    return this.deps.schedulerService.toView(schedule);
  }

  /**
   * ticket.create: without timing, an independent ticket is created and
   * dispatched immediately; with timing, a `create_ticket` schedule. Either
   * way the session becomes the ticket's origin for the result receipt.
   */
  private async onTicketCreate(
    params: TicketCreateParams,
    authorId?: string
  ): Promise<TicketCreateResult> {
    const session = await this.deps.sessionService.getSession(params.sessionId);
    if (!params.objective.trim()) throw validation('Ticket objective must not be empty');
    if (!params.timing) {
      const ticket = await this.deps.ticketService.createTicket({
        spaceId: session.spaceId,
        title: params.objective.trim().slice(0, 80),
        objective: params.objective,
        contextSummary: params.contextSummary,
        requiredTags: params.requiredTags,
        originSessionId: session.id,
      });
      if (!this.deps.dispatchService) throw new Error('dispatch service is not wired');
      await this.deps.dispatchService.dispatchTicket(ticket.id);
      return {
        kind: 'ticket',
        ticket: { id: ticket.id, objective: ticket.objective, status: ticket.status },
      };
    }
    const schedule = await this.deps.schedulerService.createSchedule(
      {
        spaceId: session.spaceId,
        timing: params.timing,
        action: {
          kind: 'create_ticket',
          objective: params.objective,
          contextSummary: params.contextSummary,
          requiredTags: params.requiredTags,
          originSessionId: session.id,
        },
      },
      authorId ?? 'agent'
    );
    return { kind: 'schedule', schedule: this.deps.schedulerService.toView(schedule) };
  }

  private async onRegister(socket: WebSocket, frame: RpcRequest): Promise<void> {
    const result = await this.deps.workerService.register(frame.params as WorkerRegisterPayload);
    this.connections.attach(result.workerId, socket);
    this.identities.set(socket, result.workerId);
    socket.once('close', () => {
      if (this.connections.detach(result.workerId, socket)) {
        void this.deps.workerService.markOffline(result.workerId);
        this.logger.info(`worker disconnected: ${result.workerId}`);
      }
    });
    this.send(socket, { kind: 'response', id: frame.id, result });
    this.logger.info(
      `worker registered: ${result.workerId} (spaces: ${result.spaceIds.join(', ')})`
    );
  }

  private send(socket: WebSocket, frame: RpcResponse): void {
    socket.send(JSON.stringify(frame));
  }
}

function parseFrame(raw: Buffer): RpcFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return undefined;
    return parsed as RpcFrame;
  } catch {
    return undefined;
  }
}

function toRpcError(err: unknown): { code: string; message: string } {
  if (err instanceof MemoryError)
    return {
      code: err.memoryCode,
      message:
        err.message +
        (err.currentRevision === undefined ? '' : ` (current revision: ${err.currentRevision})`),
    };
  if (err instanceof DomainError) {
    return { code: DOMAIN_TO_RPC_CODE[err.code], message: err.message };
  }
  return { code: RPC_ERROR_CODES.internal, message: 'Internal server error' };
}
