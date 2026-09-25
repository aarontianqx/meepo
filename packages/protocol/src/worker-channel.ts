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
  register: 'worker.register',
  heartbeat: 'worker.heartbeat',
  sessionSnapshot: 'session.snapshot',
  cronCreate: 'cron.create',
  cronList: 'cron.list',
  cronDelete: 'cron.delete',
  ticketCreate: 'ticket.create',
} as const;

/** Notifications the server pushes to the worker. */
export const WORKER_CHANNEL_EVENTS = {
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
  sessionId: string;
}

export type WorkerChannelUpstream =
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.register, WorkerRegisterPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.heartbeat, WorkerHeartbeatPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.sessionSnapshot, SessionSnapshotParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronCreate, CronCreateParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronList, CronListParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.cronDelete, CronDeleteParams>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.ticketCreate, TicketCreateParams>
  | RpcNotification<typeof SERVER_CHANNEL_EVENTS.stream, WorkerStreamEvent>;

export type WorkerChannelDownstream =
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
