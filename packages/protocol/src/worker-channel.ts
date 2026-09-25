/**
 * Worker channel contract: the single persistent WebSocket between a
 * meepo-worker (client) and meepo-server (server).
 *
 * Upstream   = worker -> server frames.
 * Downstream = server -> worker frames.
 */
import type { RpcNotification, RpcRequest, RpcResponse } from './rpc.js';
import type {
  TaskAbortPayload,
  TaskDispatchEnvelope,
  TaskSteerPayload,
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
} as const;

/** Notifications the server pushes to the worker. */
export const WORKER_CHANNEL_EVENTS = {
  taskDispatch: 'task.dispatch',
  taskSteer: 'task.steer',
  taskAbort: 'task.abort',
} as const;

/** Notifications the worker pushes to the server. */
export const SERVER_CHANNEL_EVENTS = {
  stream: 'stream',
} as const;

export type WorkerChannelUpstream =
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.register, WorkerRegisterPayload>
  | RpcRequest<typeof WORKER_CHANNEL_METHODS.heartbeat, WorkerHeartbeatPayload>
  | RpcNotification<typeof SERVER_CHANNEL_EVENTS.stream, WorkerStreamEvent>;

export type WorkerRegisterResponse = RpcResponse<WorkerRegisterResult>;
export type WorkerHeartbeatResponse = RpcResponse<{ accepted: true }>;

export type WorkerChannelDownstream =
  | WorkerRegisterResponse
  | WorkerHeartbeatResponse
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.taskDispatch, TaskDispatchEnvelope>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.taskSteer, TaskSteerPayload>
  | RpcNotification<typeof WORKER_CHANNEL_EVENTS.taskAbort, TaskAbortPayload>;
