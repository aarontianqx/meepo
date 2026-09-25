/**
 * Domain entity models for Meepo
 */
import type { ModelConfig } from '@meepo/protocol';

/** Normalized user identity, resolved from the auth layer */
export interface UserIdentity {
  userId: string;
  displayName: string;
  email?: string;
}

export type SpaceRole = 'owner' | 'manager';

/** Space membership: the only authorization data Meepo owns */
export interface SpaceMember {
  spaceId: string;
  userId: string;
  role: SpaceRole;
  createdAt: number;
}

/**
 * Pre-shared credential authorizing a worker to serve specific spaces.
 * Issued by a space member; presented by the worker at registration time.
 */
export interface WorkerEnrollmentToken {
  id: string;
  spaceIds: string[];
  issuedByUserId: string;
  label?: string;
  /** Secret value the worker presents; only stored server-side */
  token: string;
  expiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

/** Sovereign workspace boundary */
export interface Space {
  id: string;
  name: string;
  description?: string;
  repoUrl: string;
  defaultBranch: string;
  /** Worker hosting this space's main sessions; unset until the first enrolled worker registers */
  boundWorkerId?: string;
  /** IANA timezone defaulting schedule timing rules */
  timezone: string;
  /** Server-held model credentials injected into dispatches for this space */
  model?: ModelConfig;
  boundChatIds: string[];
  requiredTags: string[];
  longTermMemory: string;
  createdAt: number;
  updatedAt: number;
}

/** Worker node metadata */
export interface WorkerNode {
  id: string;
  /** Spaces this worker is authorized to serve (resolved from its enrollment token) */
  spaceIds: string[];
  hostname: string;
  tags: string[];
  maxSlots: number;
  activeSlots: number;
  status: 'online' | 'busy' | 'offline';
  lastHeartbeatAt: number;
  version: string;
}

/** Ticket entity for async background tasks */
export interface Ticket {
  id: string;
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags: string[];
  /** Session the result reports back to, when the ticket was created from one */
  originSessionId?: string;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
  assignedWorkerId?: string;
  result?: {
    branch?: string;
    prUrl?: string;
    commitSha?: string;
    summary: string;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Session kind: `main` sessions are long-lived main-flow conversations
 * (private chat, group main window); `thread` sessions are thread-bound
 * task conversations pinned to their dispatch target.
 */
export type SessionKind = 'main' | 'thread';

/** Session descriptor mapped to a Feishu window */
export interface Session {
  id: string;
  spaceId: string;
  kind: SessionKind;
  chatId: string;
  threadId: string;
  /** Feishu root message used as the reply anchor for thread messages */
  anchorMessageId?: string;
  /** Worker this session is pinned to */
  boundWorkerId?: string;
  status: 'active' | 'idle' | 'closed';
  createdAt: number;
  lastActiveAt: number;
}

/** Timing rule of a schedule: one-shot (`at`) or recurring (`cron`) */
export type ScheduleTiming =
  { kind: 'at'; at: number } | { kind: 'cron'; expression: string; timezone?: string };

/** What a schedule produces at fire time */
export type ScheduleAction =
  | {
      kind: 'create_ticket';
      objective: string;
      contextSummary?: string;
      requiredTags?: string[];
      /** Session the resulting ticket reports back to, when created from one */
      originSessionId?: string;
    }
  | { kind: 'resume_session'; sessionId: string; prompt: string };

export type ScheduleStatus = 'active' | 'done' | 'deleted';

/**
 * The single scheduling entity: when work gets produced.
 * `create_ticket` fires into a new ticket; `resume_session` fires a turn
 * in an existing session (with a 7-day staleness TTL).
 */
export interface Schedule {
  id: string;
  spaceId: string;
  timing: ScheduleTiming;
  action: ScheduleAction;
  status: ScheduleStatus;
  createdByUserId: string;
  createdAt: number;
  lastFiredAt?: number;
}

export type RunStatus = 'queued' | 'dispatched' | 'running' | 'completed' | 'failed';

/** One execution attempt of a ticket or a session turn */
export interface Run {
  id: string;
  work: { kind: 'ticket'; ticketId: string } | { kind: 'turn'; sessionId: string };
  attempt: number;
  workerId?: string;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
