import { arch, hostname, platform } from 'node:os';

import WebSocket from 'ws';

import {
  WORKER_CHANNEL_EVENTS,
  WORKER_CHANNEL_METHODS,
  type RpcErrorBody,
  type RpcFrame,
  type SessionDispatchEnvelope,
  type TaskAbortPayload,
  type TaskSteerPayload,
  type TicketDispatchEnvelope,
  type WorkerChannelDownstream,
  type WorkerHeartbeatPayload,
  type WorkerRegisterPayload,
  type WorkerRegisterResult,
} from '@meepo/protocol';

import type { WorkerConfig } from './config.js';

const WORKER_VERSION = '0.1.0';
const MAX_RECONNECT_DELAY_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/** Callbacks for server-pushed notifications, injected by the composition root. */
export interface WorkerClientHandlers {
  onSessionDispatch: (envelope: SessionDispatchEnvelope) => void;
  onTicketDispatch: (envelope: TicketDispatchEnvelope) => void;
  onTaskSteer: (payload: TaskSteerPayload) => void;
  onTaskAbort: (payload: TaskAbortPayload) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Worker channel client: a single persistent WebSocket to the server carrying
 * id-paired RPC request/response frames (register, heartbeat, session.snapshot,
 * cron.*) and fire-and-forget notifications in both directions.
 */
export class WorkerClient {
  private socket?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeTaskIds = new Set<string>();

  constructor(
    private readonly config: WorkerConfig,
    private readonly handlers: WorkerClientHandlers,
    private readonly logger: Logger = console
  ) {}

  start(): void {
    this.connect();
  }

  /** Invoke an RPC method on the server; rejects on error response or timeout. */
  rpc(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`cannot call ${method}: not connected`));
    }
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  /** Fire-and-forget upstream notification (e.g. stream events). */
  sendNotification(event: string, payload: unknown): void {
    this.send({ kind: 'notification', event, payload });
  }

  /** Track a task as running so heartbeats report accurate capacity. */
  taskStarted(taskId: string): void {
    this.activeTaskIds.add(taskId);
  }

  taskFinished(taskId: string): void {
    this.activeTaskIds.delete(taskId);
  }

  private connect(): void {
    this.socket = new WebSocket(this.config.serverUrl);

    this.socket.on('open', () => {
      this.reconnectDelayMs = 1_000;
      void this.register();
    });

    this.socket.on('message', (raw: Buffer) => {
      try {
        this.onFrame(JSON.parse(raw.toString('utf8')) as WorkerChannelDownstream);
      } catch (err) {
        this.logger.warn('ignoring unparsable frame from server', err);
      }
    });

    this.socket.on('close', () => {
      this.stopHeartbeat();
      this.failPending(new Error('connection closed'));
      this.logger.warn(`disconnected; reconnecting in ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    });

    this.socket.on('error', (err) => {
      this.logger.warn(`socket error: ${err.message}`);
      this.socket?.close();
    });
  }

  private async register(): Promise<void> {
    const payload: WorkerRegisterPayload = {
      workerId: this.config.workerId,
      enrollmentToken: this.config.enrollmentToken,
      hostname: hostname(),
      os: platform() as WorkerRegisterPayload['os'],
      arch: arch(),
      tags: this.config.tags,
      capacity: { maxSlots: this.config.maxSlots },
      version: WORKER_VERSION,
    };
    try {
      const result = (await this.rpc(WORKER_CHANNEL_METHODS.register, payload)) as
        WorkerRegisterResult | undefined;
      if (result && 'heartbeatIntervalSeconds' in result) {
        this.logger.info(
          `registered as ${result.workerId}; serving spaces: ${result.spaceIds.join(', ')}`
        );
        this.startHeartbeat(result.heartbeatIntervalSeconds);
      }
    } catch (err) {
      this.logger.error(`registration failed: ${(err as Error).message}`);
    }
  }

  private onFrame(frame: WorkerChannelDownstream): void {
    if (frame.kind === 'response') {
      this.onResponse(frame.id, frame.result, frame.error);
      return;
    }
    this.onNotification(frame.event, frame.payload);
  }

  private onResponse(id: string, result: unknown, error?: RpcErrorBody): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.logger.warn(`response for unknown request ${id}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) {
      entry.reject(new Error(`[${error.code}] ${error.message}`));
    } else {
      entry.resolve(result);
    }
  }

  private onNotification(event: string, payload: unknown): void {
    switch (event) {
      case WORKER_CHANNEL_EVENTS.sessionDispatch:
        this.handlers.onSessionDispatch(payload as SessionDispatchEnvelope);
        break;
      case WORKER_CHANNEL_EVENTS.ticketDispatch:
        this.handlers.onTicketDispatch(payload as TicketDispatchEnvelope);
        break;
      case WORKER_CHANNEL_EVENTS.taskSteer:
        this.handlers.onTaskSteer(payload as TaskSteerPayload);
        break;
      case WORKER_CHANNEL_EVENTS.taskAbort:
        this.handlers.onTaskAbort(payload as TaskAbortPayload);
        break;
      default:
        this.logger.warn(`unknown server event: ${event}`);
    }
  }

  private startHeartbeat(intervalSeconds: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const payload: WorkerHeartbeatPayload = {
        workerId: this.config.workerId,
        timestamp: Date.now(),
        capacity: { maxSlots: this.config.maxSlots, activeSlots: this.activeTaskIds.size },
        activeTaskIds: [...this.activeTaskIds],
      };
      this.rpc(WORKER_CHANNEL_METHODS.heartbeat, payload).catch((err: Error) => {
        this.logger.warn(`heartbeat failed: ${err.message}`);
      });
    }, intervalSeconds * 1000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private send(frame: RpcFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `${this.config.workerId}-${this.requestCounter}`;
  }
}
