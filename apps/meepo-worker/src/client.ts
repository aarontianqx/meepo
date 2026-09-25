import { arch, hostname, platform } from 'node:os';

import WebSocket from 'ws';

import {
  WORKER_CHANNEL_EVENTS,
  WORKER_CHANNEL_METHODS,
  type RpcFrame,
  type RpcNotification,
  type WorkerChannelDownstream,
  type WorkerHeartbeatPayload,
  type WorkerRegisterPayload,
  type WorkerRegisterResult,
} from '@meepo/protocol';

import type { WorkerConfig } from './config.js';

const WORKER_VERSION = '0.1.0';
const MAX_RECONNECT_DELAY_MS = 30_000;

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/**
 * Minimal worker client: connects to the server, registers with its enrollment
 * token, then heartbeats until disconnected. Task execution arrives in Phase 3;
 * dispatch/steer/abort notifications are logged for now.
 */
export class WorkerClient {
  private socket?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;
  private requestCounter = 0;
  private activeTaskIds: string[] = [];

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger = console
  ) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    this.socket = new WebSocket(this.config.serverUrl);

    this.socket.on('open', () => {
      this.reconnectDelayMs = 1_000;
      this.register();
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
      this.logger.warn(`disconnected; reconnecting in ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    });

    this.socket.on('error', (err) => {
      this.logger.warn(`socket error: ${err.message}`);
      this.socket?.close();
    });
  }

  private register(): void {
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
    this.send({
      kind: 'request',
      id: this.nextRequestId(),
      method: WORKER_CHANNEL_METHODS.register,
      params: payload,
    });
  }

  private onFrame(frame: WorkerChannelDownstream): void {
    if (frame.kind === 'response') {
      this.onResponse(frame);
      return;
    }
    this.onNotification(frame);
  }

  private onResponse(frame: WorkerChannelDownstream & { kind: 'response' }): void {
    if (frame.error) {
      this.logger.error(`server rejected request: [${frame.error.code}] ${frame.error.message}`);
      return;
    }
    const result = frame.result as WorkerRegisterResult | { accepted: true } | undefined;
    if (result && 'heartbeatIntervalSeconds' in result) {
      this.logger.info(
        `registered as ${result.workerId}; serving spaces: ${result.spaceIds.join(', ')}`
      );
      this.startHeartbeat(result.heartbeatIntervalSeconds);
    }
  }

  private onNotification(frame: RpcNotification): void {
    switch (frame.event) {
      case WORKER_CHANNEL_EVENTS.taskDispatch:
        this.logger.info('received task dispatch (execution not yet implemented)', frame.payload);
        break;
      case WORKER_CHANNEL_EVENTS.taskSteer:
        this.logger.info('received steer request', frame.payload);
        break;
      case WORKER_CHANNEL_EVENTS.taskAbort:
        this.logger.info('received abort request', frame.payload);
        break;
      default:
        this.logger.warn(`unknown server event: ${frame.event}`);
    }
  }

  private startHeartbeat(intervalSeconds: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const payload: WorkerHeartbeatPayload = {
        workerId: this.config.workerId,
        timestamp: Date.now(),
        capacity: { maxSlots: this.config.maxSlots, activeSlots: this.activeTaskIds.length },
        activeTaskIds: this.activeTaskIds,
      };
      this.send({
        kind: 'request',
        id: this.nextRequestId(),
        method: WORKER_CHANNEL_METHODS.heartbeat,
        params: payload,
      });
    }, intervalSeconds * 1000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
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
