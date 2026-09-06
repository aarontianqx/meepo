/**
 * Wire protocol event and envelope definitions for Meepo
 */

export type ProtocolVersion = "v1";
export const CURRENT_PROTOCOL_VERSION: ProtocolVersion = "v1";

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
  workerId: string;
  hostname: string;
  os: "darwin" | "linux" | "win32";
  arch: string;
  tags: string[];
  supportedSpaces: string[];
  capacity: {
    maxSlots: number;
  };
  version: string;
}

/** Task execution dispatch envelope (Server -> Worker) */
export interface TaskDispatchEnvelope {
  taskId: string;
  sessionId: string;
  spaceId: string;
  mode: "interactive" | "ticket";
  prompt: string;
  systemPromptContribution?: string;
  workspace: {
    repoUrl: string;
    branch: string;
    commitSha?: string;
  };
  contextMessages?: unknown[];
  timeoutSeconds?: number;
}

/** Streaming events emitted by Worker -> Server */
export type WorkerStreamEvent =
  | { type: "task_started"; taskId: string; sessionId: string; workerId: string }
  | { type: "text_delta"; taskId: string; delta: string }
  | { type: "thinking_delta"; taskId: string; delta: string }
  | { type: "tool_execution_start"; taskId: string; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_execution_update"; taskId: string; toolCallId: string; partialResult: unknown }
  | { type: "tool_execution_end"; taskId: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "task_completed"; taskId: string; resultSummary?: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "task_failed"; taskId: string; error: string; code?: string };
