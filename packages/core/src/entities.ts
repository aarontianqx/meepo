/**
 * Domain entity models for Meepo
 */

/** Sovereign workspace boundary */
export interface Space {
  id: string;
  name: string;
  description?: string;
  repoUrl: string;
  defaultBranch: string;
  boundChatIds: string[];
  requiredTags: string[];
  longTermMemory: string;
  createdAt: number;
  updatedAt: number;
}

/** Worker node metadata */
export interface WorkerNode {
  id: string;
  hostname: string;
  tags: string[];
  maxSlots: number;
  activeSlots: number;
  status: "online" | "busy" | "offline";
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
  status: "pending" | "claimed" | "running" | "completed" | "failed";
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

/** Session descriptor mapped to Feishu thread */
export interface Session {
  id: string;
  spaceId: string;
  chatId: string;
  threadId: string;
  assignedWorkerId?: string;
  status: "active" | "idle" | "closed";
  createdAt: number;
  lastActiveAt: number;
}
