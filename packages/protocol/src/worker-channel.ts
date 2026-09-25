/**
 * Worker channel contract: the single persistent WebSocket between a
 * meepo-worker (client) and meepo-server (server).
 *
 * Upstream   = worker -> server frames.
 * Downstream = server -> worker frames.
 */
import type { RpcNotification, RpcRequest, RpcResponse } from './rpc.js';
import type {
  CronCreateParams,
  CronDeleteParams,
  CronJobView,
  CronListParams,
  SessionDispatchEnvelope,
  SessionSnapshot,
  TaskAbortPayload,
  TaskSteerPayload,
  TicketDispatchEnvelope,
  WorkerHeartbeatPayload,
  WorkerRegisterPayload,
  WorkerRegisterResult,
  WorkerStreamEvent,
} from './types.js';

export const WORKER_CHANNEL_PATH = '/ws/worker';

/** RPC methods the worker invokes on the server. */
export const WORKER_CHANNEL_METHODS = {
  register: 'worker.register',
  heartbeat: 'worker.heartbeat',
  sessionSnapshot: 'session.snapshot',
  cronCreate: 'cron.create',
  cronList: 'cron.list',
  cronDelete: 'cron.delete',
} as const;

/** Notifications the server pushes to the worker. */
export const WORKER_CHANNEL_EVENTS = {
  sessionDispatch: 'session.dispatch',
  ticketDispatch: 'ticket.dispatch',
  taskSteer: 'task.steer',
  taskAbort: 'task.abort',
} as const;

/** Notifications the worker pushes to the server. */
export const SERVER_CHANNEL_EVENTS = {
  stream: 'stream',
} as const;

export interface SessionSnapshotParams {
  sessionId: string;
}

export type WorkerChannelUpstream =
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.register, WorkerRegisterPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.heartbeat, WorkerHeartbeatPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.sessionSnapshot, SessionSnapshotParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronCreate, CronCreateParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronList, CronListParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronDelete, CronDeleteParams>
  | RpcNotification<typeof SERVER_CHANNEL_EVENTS.stream, WorkerStreamEvent>;

export type WorkerChannelDownstream =
  | RpcResponse<WorkerRegisterResult>
  | RpcResponse<{ accepted: true }>
  | RpcResponse<SessionSnapshot>
  | RpcResponse<CronJobView>
  | RpcResponse<CronJobView[]>
  | RpcResponse<{ deleted: true }>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.sessionDispatch, SessionDispatchEnvelope>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.ticketDispatch, TicketDispatchEnvelope>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.taskSteer, TaskSteerPayload>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.taskAbort, TaskAbortPayload>;
