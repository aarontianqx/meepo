/**
 * Wire protocol event and envelope definitions for Meepo
 */

export type ProtocolVersion = 'v1';
export const CURRENT_PROTOCOL_VERSION: ProtocolVersion = 'v1';

/** Heartbeat payload emitted by worker to server */
export interface WorkerHeartbeatPayload {
  workerId: string;
  timestamp: number;
  capacity: {
    maxSlots: number;
    activeSlots: number;
    cpuUsage?: number;
    memoryUsage?: number;
  };
  activeTaskIds: string[];
}

/** Registration payload sent upon initial connection */
export interface WorkerRegisterPayload {
  /** Stable worker identifier, generated and persisted by the worker itself */
  workerId: string;
  /**
   * Enrollment token issued by a space owner via the console / server API.
   * The server resolves it to the account and the set of spaces this worker
   * is allowed to serve — workers never enumerate space IDs themselves.
   */
  enrollmentToken: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: string;
  tags: string[];
  capacity: {
    maxSlots: number;
  };
  version: string;
}

/** Result returned by the server after a successful registration */
export interface WorkerRegisterResult {
  workerId: string;
  /** Spaces the enrollment token authorizes this worker to serve */
  spaceIds: string[];
  heartbeatIntervalSeconds: number;
}

/** Server-initiated steering message injected into an in-flight agent turn */
export interface TaskSteerPayload {
  taskId: string;
  message: string;
}

/** Server-initiated cancellation of a running task */
export interface TaskAbortPayload {
  taskId: string;
  reason?: string;
}

/** Where a dispatched unit of work originates */
export type DispatchSource =
  | { kind: 'user_message'; messageId: string }
  | { kind: 'cron'; jobId: string; coalescedCount: number; stale: boolean }
  | { kind: 'reminder'; reminderId: string }
  | { kind: 'webhook'; event: string }
  | { kind: 'system' };

/** Delivery semantics the server requests for a turn */
export type DeliveryMode = 'urgent' | 'wait' | 'if_idle';

/** Model credentials held per space by the server and injected per dispatch */
export interface ModelConfig {
  /** pi-ai compatible provider identifier, e.g. "openai-completions" */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Workspace a turn executes in; null for no-workspace (main) sessions */
export interface WorkspaceSpec {
  repoUrl: string;
  branch: string;
  commitSha?: string;
}

/** Session dispatch: a turn inside an existing (or newly created) session context */
export interface SessionDispatchEnvelope {
  taskId: string;
  sessionId: string;
  spaceId: string;
  sessionKind: 'main' | 'task';
  prompt: string;
  source: DispatchSource;
  delivery: DeliveryMode;
  workspace: WorkspaceSpec | null;
  model: ModelConfig;
  timeoutSeconds?: number;
}

/** Ticket dispatch: a fresh, isolated execution context */
export interface TicketDispatchEnvelope {
  taskId: string;
  ticketId: string;
  spaceId: string;
  objective: string;
  contextSummary?: string;
  workspace: WorkspaceSpec;
  model: ModelConfig;
  source: DispatchSource;
  timeoutSeconds?: number;
}

/** Simplified transcript entry used for session rehydration snapshots */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
}

/** Full session snapshot served to a worker cold-starting a session */
export interface SessionSnapshot {
  sessionId: string;
  version: number;
  messages: TranscriptMessage[];
}

/** Cron tool proxy: create a session-scoped cron job */
export interface CronCreateParams {
  sessionId: string;
  /** 5-field cron expression interpreted in `timezone` */
  cron: string;
  prompt: string;
  recurring: boolean;
  timezone?: string;
}

export interface CronListParams {
  sessionId: string;
}

export interface CronDeleteParams {
  sessionId: string;
  jobId: string;
}

/** Cron job as returned to the agent and console */
export interface CronJobView {
  id: string;
  sessionId: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  timezone: string;
  nextFireAt: number | null;
  createdAt: number;
  lastFiredAt?: number;
}

/** Streaming events emitted by Worker -> Server */
export type WorkerStreamEvent =
  | {
      type: 'task_started';
      taskId: string;
      workerId: string;
      sessionId?: string;
      ticketId?: string;
    }
  | { type: 'text_delta'; taskId: string; delta: string }
  | { type: 'thinking_delta'; taskId: string; delta: string }
  | {
      type: 'tool_execution_start';
      taskId: string;
      toolName: string;
      toolCallId: string;
      args: unknown;
    }
  | { type: 'tool_execution_update'; taskId: string; toolCallId: string; partialResult: unknown }
  | {
      type: 'tool_execution_end';
      taskId: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: 'task_completed';
      taskId: string;
      resultSummary?: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'task_failed'; taskId: string; error: string; code?: string };
