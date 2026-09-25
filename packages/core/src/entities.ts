/**
 * Domain entity models for Meepo
 */

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
  /** IANA timezone defaulting scheduled records (reminders, crons) */
  timezone: string;
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
 * Session kind: `main` sessions are long-lived conversations (private chat,
 * main window) and follow the space binding; `task` sessions are thread-bound
 * coding sessions pinned to their dispatch target.
 */
export type SessionKind = 'main' | 'task';

/** Session descriptor mapped to a Feishu window */
export interface Session {
  id: string;
  spaceId: string;
  kind: SessionKind;
  chatId: string;
  threadId: string;
  /** Worker this session is pinned to */
  boundWorkerId?: string;
  status: 'active' | 'idle' | 'closed';
  createdAt: number;
  lastActiveAt: number;
}
