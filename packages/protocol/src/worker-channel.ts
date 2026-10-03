/**
 * Worker channel contract: the single persistent WebSocket between a
 * meepo-worker (client) and meepo-server (server).
 *
 * Upstream   = worker -> server frames.
 * Downstream = server -> worker frames.
 */
import type { RpcNotification, RpcRequest, RpcResponse } from './rpc.js';
import type {
  SequencedWorkerEvent,
  ReconcileParams,
  ContextAppendPayload,
  CronCreateParams,
  CronDeleteParams,
  CronListParams,
  RunAbortPayload,
  RunSteerPayload,
  ScheduleView,
  SessionSnapshot,
  TicketCreateParams,
  TicketCreateResult,
  TicketDispatchEnvelope,
  TurnDispatchEnvelope,
  WorkerHeartbeatPayload,
  WorkerRegisterPayload,
  WorkerRegisterResult,
  WorkerStreamEvent,
} from './types.js';

export const WORKER_CHANNEL_PATH = '/ws/worker';

/** RPC methods the worker invokes on the server. */
export const WORKER_CHANNEL_METHODS = {
  mediaRead: 'media.read',
  compactionRecord: 'session.compaction',
  promptPrepare: 'prompt.prepare',
  promptRecord: 'prompt.record',
  memory: 'memory.call',
  ready: 'worker.ready',
  register: 'worker.register',
  streamAppend: 'stream.append',
  reconcile: 'run.reconcile',
  heartbeat: 'worker.heartbeat',
  sessionSnapshot: 'session.snapshot',
  cronCreate: 'cron.create',
  cronList: 'cron.list',
  cronDelete: 'cron.delete',
  ticketCreate: 'ticket.create',
} as const;

/** Notifications the server pushes to the worker. */
export const WORKER_CHANNEL_EVENTS = {
  contextAppend: 'context.append',
  sessionClosed: 'session.closed',
  turnDispatch: 'turn.dispatch',
  ticketDispatch: 'ticket.dispatch',
  runSteer: 'run.steer',
  runAbort: 'run.abort',
} as const;

/** Notifications the worker pushes to the server. */
export const SERVER_CHANNEL_EVENTS = {
  stream: 'stream',
} as const;

export interface SessionSnapshotParams {
  useCompaction?: boolean;
  afterSeq?: number;
  sessionId: string;
  /** Exclude transcript entries at or after this timestamp */
  beforeTimestamp?: number;
  beforeSeq?: number;
}

export interface MediaReadParams {
  sessionId: string;
  messageId: string;
  fileKey: string;
}
export interface MediaReadResult {
  data: string;
  sizeBytes: number;
  mimeType: string;
}

export interface CompactionRecordParams {
  sessionId: string;
  runId: string;
  summary: string;
  coversThroughSeq: number;
  degraded?: boolean;
}
export type WorkerChannelUpstream =
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.compactionRecord, CompactionRecordParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.mediaRead, MediaReadParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.streamAppend, SequencedWorkerEvent>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.reconcile, ReconcileParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.ready, Record<string, never>>
  | RpcRequest<
      typeof WORKER_CHANNEL_METHODS.memory,
      {
        sessionId?: string;
        ticketId?: string;
        runId: string;
        operation: 'list' | 'search' | 'read' | 'write' | 'delete' | 'map';
        input: Record<string, unknown>;
      }
    >
  | RpcRequest<
      typeof WORKER_CHANNEL_METHODS.promptPrepare,
      { sessionId?: string; ticketId?: string }
    >
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.promptRecord, { sessionId: string; snapshot: unknown }>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.register, WorkerRegisterPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.heartbeat, WorkerHeartbeatPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.sessionSnapshot, SessionSnapshotParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronCreate, CronCreateParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronList, CronListParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronDelete, CronDeleteParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.ticketCreate, TicketCreateParams>
  | RpcNotification<typeof SERVER_CHANNEL_EVENTS.stream, WorkerStreamEvent>;

export type WorkerChannelDownstream =
  | RpcResponse<unknown>
  | RpcNotification<'context.append', ContextAppendPayload>
  | RpcNotification<'session.closed', { sessionId: string }>
  | RpcResponse<WorkerRegisterResult>
  | RpcResponse<{ accepted: true }>
  | RpcResponse<SessionSnapshot>
  | RpcResponse<ScheduleView>
  | RpcResponse<ScheduleView[]>
  | RpcResponse<{ deleted: true }>
  | RpcResponse<TicketCreateResult>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.turnDispatch, TurnDispatchEnvelope>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.ticketDispatch, TicketDispatchEnvelope>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.runSteer, RunSteerPayload>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.runAbort, RunAbortPayload>;
