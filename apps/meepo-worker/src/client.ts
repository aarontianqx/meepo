import { arch, hostname, platform } from 'node:os';

import WebSocket from 'ws';

import {
  CURRENT_PROTOCOL_VERSION,
  type WorkerStreamEvent,
  type SequencedWorkerEvent,
  type StreamAck,
  type ReconcileResult,
  type ContextAppendPayload,
  WORKER_CHANNEL_EVENTS,
  WORKER_CHANNEL_METHODS,
  type RpcErrorBody,
  type RpcFrame,
  type RunAbortPayload,
  type RunSteerPayload,
  type TicketDispatchEnvelope,
  type TurnDispatchEnvelope,
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
  onTurnDispatch: (envelope: TurnDispatchEnvelope) => void;
  onTicketDispatch: (envelope: TicketDispatchEnvelope) => void;
  onRunSteer: (payload: RunSteerPayload) => void;
  onContextAppend?: (payload: ContextAppendPayload) => void;
  onSessionClosed?: (sessionId: string) => void;
  onRunAbort: (payload: RunAbortPayload) => void;
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
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private socket?: WebSocket;
  private ready = false;
  private readonly invalidRuns = new Set<string>();
  private leaseTimer?: NodeJS.Timeout;
  private leaseDurationMs = 45000;
  private readonly eventBuffers = new Map<string, SequencedWorkerEvent[]>();
  private readonly sequences = new Map<string, number>();
  private readonly sending = new Map<string, Promise<void>>();
  private readonly seenDispatches = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly readyWaiters = new Set<() => void>();
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ownedRunIds = new Set<string>();
  private readonly activeRunIds = new Set<string>();

  constructor(
    private readonly config: WorkerConfig,
    private readonly handlers: WorkerClientHandlers,
    private readonly logger: Logger = console
  ) {}

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.eventBuffers.keys()].map((id) => this.flushRun(id)));
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.stopHeartbeat();
    this.failPending(new Error('Worker stopped'));
    this.socket?.close();
    for (const resolve of this.readyWaiters) resolve();
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

  /** Await registration/reconciliation before beginning another model or tool call. */
  async beforeExecution(runId?: string): Promise<void> {
    const check = () => {
      if (this.stopped) throw new Error('Worker stopped');
      if (runId && this.invalidRuns.has(runId)) throw new Error('Execution lease invalidated');
    };
    check();
    while (!this.ready) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.readyWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 250);
        this.readyWaiters.add(done);
      });
      check();
    }
    if (runId) await this.flushRun(runId);
    else for (const id of this.eventBuffers.keys()) await this.flushRun(id);
    check();
    if (!this.ready) return this.beforeExecution(runId);
  }

  sendStreamEvent(event: WorkerStreamEvent): void {
    const clientSeq = (this.sequences.get(event.runId) ?? 0) + 1;
    this.sequences.set(event.runId, clientSeq);
    const events = this.eventBuffers.get(event.runId) ?? [];
    events.push({ ...event, clientSeq });
    this.eventBuffers.set(event.runId, events);
    void this.flushRun(event.runId);
  }

  private flushRun(runId: string): Promise<void> {
    const existing = this.sending.get(runId);
    if (existing) return existing;
    const work = (async () => {
      const events = this.eventBuffers.get(runId);
      while (this.ready && events?.length) {
        try {
          const ack = (await this.rpc(WORKER_CHANNEL_METHODS.streamAppend, events[0])) as StreamAck;
          if (!ack.accepted) {
            if (ack.reason === 'sequence_gap') throw new Error('server rejected event sequence');
            this.invalidRuns.add(runId);
            this.handlers.onRunAbort({ runId, reason: ack.reason });
            events.splice(0);
            break;
          }
          while (events[0] && events[0].clientSeq <= ack.lastConfirmedClientSeq) events.shift();
        } catch (err) {
          this.logger.warn(`stream delivery paused: ${(err as Error).message}`);
          this.ready = false;
          this.socket?.close();
          break;
        }
      }
      if (!events?.length) this.eventBuffers.delete(runId);
    })().finally(() => {
      this.sending.delete(runId);
    });
    this.sending.set(runId, work);
    return work;
  }

  /** Fire-and-forget upstream notification (e.g. stream events). */
  sendNotification(event: string, payload: unknown): void {
    this.send({ kind: 'notification', event, payload });
  }

  /** Track a run as active so heartbeats report accurate capacity. */
  runStarted(runId: string): void {
    this.activeRunIds.add(runId);
  }

  runFinished(runId: string): void {
    this.activeRunIds.delete(runId);
    this.ownedRunIds.delete(runId);
    this.finished.add(runId);
    while (this.finished.size > 2048) {
      const old = this.finished.values().next().value!;
      if (this.eventBuffers.has(old)) break;
      this.finished.delete(old);
      this.sequences.delete(old);
      this.seenDispatches.delete(old);
      this.invalidRuns.delete(old);
    }
  }

  private connect(): void {
    if (this.stopped) return;
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
      this.ready = false;
      if (this.stopped) return;
      if (!this.leaseTimer)
        this.leaseTimer = setTimeout(() => {
          this.leaseTimer = undefined;
          for (const runId of this.ownedRunIds) {
            this.invalidRuns.add(runId);
            this.handlers.onRunAbort({ runId, reason: 'lease_lost' });
          }
          for (const resolve of this.readyWaiters) resolve();
        }, this.leaseDurationMs);
      this.stopHeartbeat();
      this.failPending(new Error('connection closed'));
      this.logger.warn(`disconnected; reconnecting in ${this.reconnectDelayMs}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
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
      protocolVersion: CURRENT_PROTOCOL_VERSION,
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
        const reconciled = (await this.rpc(WORKER_CHANNEL_METHODS.reconcile, {
          activeRunIds: [...this.ownedRunIds],
          recentlyFinishedRunIds: [...this.finished],
        })) as ReconcileResult;
        for (const runId of reconciled.invalidRunIds) {
          this.invalidRuns.add(runId);
          this.handlers.onRunAbort({ runId, reason: 'run_invalidated' });
        }
        if (this.leaseTimer) clearTimeout(this.leaseTimer);
        this.leaseTimer = undefined;
        this.leaseDurationMs = result.heartbeatIntervalSeconds * 3000;
        for (const [runId, events] of this.eventBuffers) {
          const confirmed = reconciled.lastConfirmedClientSeq[runId] ?? 0;
          while (events[0] && events[0].clientSeq <= confirmed) events.shift();
        }
        this.ready = true;
        for (const resolve of this.readyWaiters) resolve();
        this.readyWaiters.clear();
        for (const id of this.eventBuffers.keys()) await this.flushRun(id);
        await this.rpc(WORKER_CHANNEL_METHODS.ready, {});
        this.logger.info(
          `registered as ${result.workerId}; serving spaces: ${result.spaceIds.join(', ')}`
        );
        this.startHeartbeat(result.heartbeatIntervalSeconds);
      }
    } catch (err) {
      this.logger.error(`registration failed: ${(err as Error).message}`);
      this.socket?.close();
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
    if (
      event === WORKER_CHANNEL_EVENTS.turnDispatch ||
      event === WORKER_CHANNEL_EVENTS.ticketDispatch
    ) {
      const id = (payload as { runId: string }).runId;
      if (this.seenDispatches.has(id)) return;
      this.seenDispatches.add(id);
      this.ownedRunIds.add(id);
    }
    switch (event) {
      case WORKER_CHANNEL_EVENTS.contextAppend:
        this.handlers.onContextAppend?.(payload as ContextAppendPayload);
        break;
      case WORKER_CHANNEL_EVENTS.sessionClosed:
        this.handlers.onSessionClosed?.((payload as { sessionId: string }).sessionId);
        break;
      case WORKER_CHANNEL_EVENTS.turnDispatch:
        this.handlers.onTurnDispatch(payload as TurnDispatchEnvelope);
        break;
      case WORKER_CHANNEL_EVENTS.ticketDispatch:
        this.handlers.onTicketDispatch(payload as TicketDispatchEnvelope);
        break;
      case WORKER_CHANNEL_EVENTS.runSteer:
        this.handlers.onRunSteer(payload as RunSteerPayload);
        break;
      case WORKER_CHANNEL_EVENTS.runAbort:
        this.handlers.onRunAbort(payload as RunAbortPayload);
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
        capacity: { maxSlots: this.config.maxSlots, activeSlots: this.activeRunIds.size },
        activeRunIds: [...this.ownedRunIds],
      };
      this.rpc(WORKER_CHANNEL_METHODS.heartbeat, payload).catch((err: Error) => {
        this.logger.warn(`heartbeat failed: ${err.message}`);
        this.ready = false;
        this.socket?.close();
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
