import type { WebSocket } from 'ws';

import {
  RPC_ERROR_CODES,
  WORKER_CHANNEL_METHODS,
  type RpcFrame,
  type RpcRequest,
  type RpcResponse,
  type WorkerHeartbeatPayload,
  type WorkerRegisterPayload,
} from '@meepo/protocol';

import { DomainError } from '../../domain/errors.js';
import type { WorkerService } from '../../domain/workers/worker-service.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

const DOMAIN_TO_RPC_CODE: Record<DomainError['code'], string> = {
  not_found: RPC_ERROR_CODES.notFound,
  validation: RPC_ERROR_CODES.invalidParams,
  conflict: RPC_ERROR_CODES.invalidParams,
  unauthorized: RPC_ERROR_CODES.unauthorized,
};

/**
 * Handles the persistent worker WebSocket channel: registration, heartbeats,
 * and (in later phases) task dispatch and stream relay.
 */
export class WorkerChannelHandler {
  constructor(
    private readonly workerService: WorkerService,
    private readonly logger: Logger = console
  ) {}

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

    // Notifications (e.g. stream events) are accepted but not yet relayed.
  }

  private async onRequest(socket: WebSocket, frame: RpcRequest): Promise<void> {
    try {
      switch (frame.method) {
        case WORKER_CHANNEL_METHODS.register: {
          const result = await this.workerService.register(frame.params as WorkerRegisterPayload);
          this.send(socket, { kind: 'response', id: frame.id, result });
          this.logger.info(
            `worker registered: ${result.workerId} (spaces: ${result.spaceIds.join(', ')})`
          );
          // Registration binds the socket to the worker for disconnect cleanup.
          socket.once('close', () => void this.workerService.markOffline(result.workerId));
          return;
        }
        case WORKER_CHANNEL_METHODS.heartbeat: {
          const params = frame.params as WorkerHeartbeatPayload;
          await this.workerService.heartbeat(params.workerId, params);
          this.send(socket, { kind: 'response', id: frame.id, result: { accepted: true } });
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
