import WebSocket from 'ws';

import {
  RPC_ERROR_CODES,
  SERVER_CHANNEL_EVENTS,
  WORKER_CHANNEL_METHODS,
  type CronCreateParams,
  type CronDeleteParams,
  type CronListParams,
  type RpcFrame,
  type RpcRequest,
  type RpcResponse,
  type SessionSnapshotParams,
  type WorkerChannelDownstream,
  type WorkerHeartbeatPayload,
  type WorkerRegisterPayload,
  type WorkerStreamEvent,
} from '@meepo/protocol';

import type { WorkerSender } from '../../domain/dispatch/worker-sender.js';
import { DomainError } from '../../domain/errors.js';
import type { SchedulerService } from '../../domain/schedule/scheduler-service.js';
import type { StreamProcessor } from '../../domain/sessions/stream-processor.js';
import type { TranscriptService } from '../../domain/sessions/transcript-service.js';
import type { WorkerService } from '../../domain/workers/worker-service.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

const DOMAIN_TO_RPC_CODE: Record<DomainError['code'], string> = {
  not_found: RPC_ERROR_CODES.notFound,
  validation: RPC_ERROR_CODES.invalidParams,
  conflict: RPC_ERROR_CODES.invalidParams,
  unauthorized: RPC_ERROR_CODES.unauthorized,
};

export interface WorkerChannelDeps {
  workerService: WorkerService;
  schedulerService: SchedulerService;
  transcriptService: TranscriptService;
  streamProcessor: StreamProcessor;
}

/**
 * Handles the persistent worker WebSocket channel: registration, heartbeats,
 * session snapshots, cron tool proxying, and stream event ingestion. Also
 * implements the WorkerSender port used by the dispatch pipeline.
 */
export class WorkerChannelHandler implements WorkerSender {
  private readonly sockets = new Map<string, WebSocket>();
  private onWorkerReady?: (workerId: string) => void;

  constructor(
    private readonly deps: WorkerChannelDeps,
    private readonly logger: Logger = console
  ) {}

  /** Late-bound because the dispatch service is created after the channel. */
  setOnWorkerReady(callback: (workerId: string) => void): void {
    this.onWorkerReady = callback;
  }

  isConnected(workerId: string): boolean {
    return this.sockets.get(workerId)?.readyState === WebSocket.OPEN;
  }

  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void {
    const socket = this.sockets.get(workerId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
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
      this.deps.streamProcessor.onEvent(frame.payload as WorkerStreamEvent);
    }
  }

  private async onRequest(socket: WebSocket, frame: RpcRequest): Promise<void> {
    try {
      switch (frame.method) {
        case WORKER_CHANNEL_METHODS.register:
          await this.onRegister(socket, frame);
          return;
        case WORKER_CHANNEL_METHODS.heartbeat: {
          const params = frame.params as WorkerHeartbeatPayload;
          await this.deps.workerService.heartbeat(params.workerId, params);
          this.send(socket, { kind: 'response', id: frame.id, result: { accepted: true } });
          return;
        }
        case WORKER_CHANNEL_METHODS.sessionSnapshot: {
          const params = frame.params as SessionSnapshotParams;
          const snapshot = await this.deps.transcriptService.getSnapshot(params.sessionId);
          this.send(socket, { kind: 'response', id: frame.id, result: snapshot });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronCreate: {
          const view = await this.deps.schedulerService.createCron(
            frame.params as CronCreateParams
          );
          this.send(socket, { kind: 'response', id: frame.id, result: view });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronList: {
          const views = await this.deps.schedulerService.listCrons(
            (frame.params as CronListParams).sessionId
          );
          this.send(socket, { kind: 'response', id: frame.id, result: views });
          return;
        }
        case WORKER_CHANNEL_METHODS.cronDelete: {
          const params = frame.params as CronDeleteParams;
          await this.deps.schedulerService.deleteCron(params.sessionId, params.jobId);
          this.send(socket, { kind: 'response', id: frame.id, result: { deleted: true } });
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

  private async onRegister(socket: WebSocket, frame: RpcRequest): Promise<void> {
    const result = await this.deps.workerService.register(frame.params as WorkerRegisterPayload);
    const previous = this.sockets.get(result.workerId);
    if (previous && previous !== socket) previous.close();
    this.sockets.set(result.workerId, socket);
    socket.once('close', () => {
      if (this.sockets.get(result.workerId) === socket) {
        this.sockets.delete(result.workerId);
        void this.deps.workerService.markOffline(result.workerId);
        this.logger.info(`worker disconnected: ${result.workerId}`);
      }
    });
    this.send(socket, { kind: 'response', id: frame.id, result });
    this.logger.info(
      `worker registered: ${result.workerId} (spaces: ${result.spaceIds.join(', ')})`
    );
    this.onWorkerReady?.(result.workerId);
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
  if (err instanceof DomainError) {
    return { code: DOMAIN_TO_RPC_CODE[err.code], message: err.message };
  }
  return { code: RPC_ERROR_CODES.internal, message: 'Internal server error' };
}
