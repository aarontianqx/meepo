/** Wire shapes returned by the control-plane API that are not shared entities. */

import type { Schedule, Session } from '@meepo/core';
import type { ReasoningEffort } from '@meepo/protocol';

export interface Me {
  userId: string;
  displayName: string;
  isAdmin: boolean;
}

export interface HealthStatus {
  status: string;
  uptimeSeconds: number;
  timestamp: number;
}

export interface SpaceUsage {
  runCount: number;
  reportedRunCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costReportedRunCount: number;
}

/** A registry model with its provider's name; never carries credentials or the base URL. */
export interface ModelEntry {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  /** Supported thinking strengths; empty for a non-reasoning model. */
  reasoningEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  imageInput: boolean;
  isDefault: boolean;
}

/** Admin view of a provider; the API key is never returned. */
export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  modelCount: number;
}

export interface ProviderInput {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelInput {
  id: string;
  providerId: string;
  model: string;
  /** Capabilities left out are suggested from the model name (create) or kept (update). */
  contextWindow?: number;
  maxTokens?: number;
  reasoningEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  imageInput?: boolean;
  isDefault?: boolean;
}

export interface Channel {
  id: string;
  type: 'feishu';
  name: string;
  appId: string;
  spaceId: string;
  allowedOpenIds: string[];
  boundChatIds: string[];
  updatedAt?: number;
}

export interface ChannelInput {
  type: 'feishu';
  name: string;
  appId: string;
  appSecret?: string;
  spaceId: string;
  allowedOpenIds: string[];
  boundChatIds: string[];
}

export interface EnrollmentRecord {
  id: string;
  spaceIds: string[];
  issuedByUserId: string;
  label?: string;
  workerId?: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface MemoryMeta {
  path: string;
  description: string;
  keywords: string[];
  revision: number;
  pinned: boolean;
  updatedAt: number;
  updatedBy:
    { kind: 'console'; userId: string } | { kind: 'agent'; sessionId: string; authorId?: string };
}

export interface MemorySearchHit extends MemoryMeta {
  matched_fields: string[];
  snippets: string[];
}

export interface MemoryEntry extends MemoryMeta {
  content: string;
}

export interface MemoryWriteBody {
  description: string;
  content: string;
  keywords: string[];
  pinned: boolean;
  expected_revision: number;
}

/** Schedule list item with the server-computed next fire time. */
export type ScheduleItem = Schedule & { nextFireAt: number | null };

/** Session list item: the session plus labels derived from its opening message. */
export type SessionItem = Session & {
  /** Opening user message, collapsed to one line. */
  title?: string;
  /** Group name, or a private-chat marker, as recorded on that message. */
  chatLabel?: string;
  /** Display name (or id) of whoever sent the opening message. */
  author?: string;
};
