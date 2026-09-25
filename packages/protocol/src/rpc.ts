/**
 * Generic RPC envelope definitions shared by all Meepo wire channels.
 *
 * Every frame on a channel is one of:
 * - `request`:      expects a `response` with the same `id`.
 * - `response`:     resolves a prior `request`; carries either `result` or `error`.
 * - `notification`: fire-and-forget event, never answered.
 */

export interface RpcRequest<M extends string = string, P = unknown> {
  kind: 'request';
  id: string;
  method: M;
  params: P;
}

export interface RpcErrorBody {
  code: string;
  message: string;
}

export interface RpcResponse<R = unknown> {
  kind: 'response';
  id: string;
  result?: R;
  error?: RpcErrorBody;
}

export interface RpcNotification<E extends string = string, P = unknown> {
  kind: 'notification';
  event: E;
  payload: P;
}

export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

export const RPC_ERROR_CODES = {
  invalidFrame: 'invalid_frame',
  unknownMethod: 'unknown_method',
  invalidParams: 'invalid_params',
  unauthorized: 'unauthorized',
  notFound: 'not_found',
  internal: 'internal',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];
