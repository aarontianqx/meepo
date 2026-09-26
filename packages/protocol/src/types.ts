/**
 * Wire protocol event and envelope definitions for Meepo
 *
 * Unified execution model:
 * - Schedule: when work is produced (timing + action).
 * - Ticket / Turn: the two work units (independent vs session-bound).
 * - Run: one execution attempt of a Ticket or Turn.
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
  activeRunIds: string[];
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

/** Server-initiated steering message injected into an in-flight run */
export interface RunSteerPayload {
  runId: string;
  message: string;
}

/** Server-initiated cancellation of a run */
export interface RunAbortPayload {
  runId: string;
  reason?: string;
}

/** Where a dispatched unit of work originates */
export type DispatchSource =
  | { kind: 'user_message'; messageId: string }
  | { kind: 'schedule'; scheduleId: string; coalescedCount: number; stale: boolean }
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

/** Turn dispatch: a turn inside an existing (or newly created) session context */
export interface TurnDispatchEnvelope {
  runId: string;
  sessionId: string;
  spaceId: string;
  sessionKind: 'main' | 'thread';
  prompt: string;
  source: DispatchSource;
  delivery: DeliveryMode;
  /** Snapshot excludes transcript entries at or after this timestamp (the current turn's own message) */
  snapshotBefore?: number;
  /** Space memory and repo hints primed into the agent's system prompt */
  systemPromptContribution?: string;
  model: ModelConfig;
  timeoutSeconds?: number;
}

/** Ticket dispatch: a fresh, isolated execution context */
export interface TicketDispatchEnvelope {
  runId: string;
  ticketId: string;
  spaceId: string;
  objective: string;
  contextSummary?: string;
  /** Space memory and repo hints primed into the agent's system prompt */
  systemPromptContribution?: string;
  model: ModelConfig;
  source: DispatchSource;
  timeoutSeconds?: number;
}

/** Simplified transcript entry used for session rehydration snapshots */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  /** Display name (or open_id) of the speaker, for multi-party windows */
  author?: string;
}

/** Full session snapshot served to a worker cold-starting a session */
export interface SessionSnapshot {
  sessionId: string;
  version: number;
  messages: TranscriptMessage[];
}

/** Timing rule for a schedule: one-shot (`at`) or recurring (`cron`) */
export type Timing =
  { kind: 'at'; at: number } | { kind: 'cron'; expression: string; timezone?: string };

/** Agent tool: schedule a wakeup for the calling session (resume_session action) */
export interface CronCreateParams {
  sessionId: string;
  prompt: string;
  timing: Timing;
}

/** Agent tool: create an independent ticket (create_ticket action or direct) */
export interface TicketCreateParams {
  sessionId: string;
  objective: string;
  contextSummary?: string;
  requiredTags?: string[];
  /** When to run; omit for immediate dispatch */
  timing?: Timing;
}

export interface CronListParams {
  sessionId: string;
}

export interface CronDeleteParams {
  sessionId: string;
  scheduleId: string;
}

/** Schedule as returned to the agent and console */
export interface ScheduleView {
  id: string;
  action: 'create_ticket' | 'resume_session';
  timing: Timing;
  prompt?: string;
  objective?: string;
  nextFireAt: number | null;
  createdAt: number;
  lastFiredAt?: number;
}

/** Result of a ticket.create call: direct ticket or a scheduled action */
export type TicketCreateResult =
  | { kind: 'ticket'; ticket: { id: string; objective: string; status: string } }
  | { kind: 'schedule'; schedule: ScheduleView };

/** Streaming events emitted by Worker -> Server */
export type WorkerStreamEvent =
  | {
      type: 'run_started';
      runId: string;
      workerId: string;
      sessionId?: string;
      ticketId?: string;
    }
  | { type: 'text_delta'; runId: string; delta: string }
  | { type: 'thinking_delta'; runId: string; delta: string }
  | {
      type: 'tool_execution_start';
      runId: string;
      toolName: string;
      toolCallId: string;
      args: unknown;
    }
  | { type: 'tool_execution_update'; runId: string; toolCallId: string; partialResult: unknown }
  | {
      type: 'tool_execution_end';
      runId: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: 'run_completed';
      runId: string;
      resultSummary?: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'run_failed'; runId: string; error: string; code?: string };
