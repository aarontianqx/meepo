# Domain Model

> **Scope**: Defines the canonical, implementation-independent logical schemas, field constraints, uniqueness invariants, and retention lifecycles for all persistent and cross-plane domain entities in Meepo. Behavioral state machines live in `specs/features/`.

## 1. Entity Ownership Overview

```text
Global Scope (Admin-Managed)
  ├── ModelRegistry (ModelEntry[])
  └── ChannelRegistry (Channel[] ──N:1──► Space)

Space Scope (Tenant-Isolated)
  ├── Space
  ├── SpaceMember[]          unique (spaceId, userId)
  ├── WorkerEnrollmentToken[] ──M:N──► Space, 1:1 bound to WorkerNode
  ├── WebhookCredential       1:1 per Space + WebhookRequestRecord[] (30d dedup)
  ├── MemoryEntry[]          unique (spaceId, path), tombstone-backed revisions
  ├── Session[]              unique active (spaceId, channelId, chatId, threadId)
  │     ├── CanonicalEvent[] ordered by (sessionId, seq)
  │     └── CompactionCache[] keyed by (sessionId, coversThroughSeq)
  ├── Ticket[]               1:N attempts ──► Run[] + TicketReceipt[]
  └── Schedule[]             fires ──► ScheduleFire[] ──► Ticket | Turn (Run)
```

All timestamps are Unix epoch milliseconds in UTC (`integer`). Identifiers (`id`) are opaque strings (UUIDv4 for server-created entities unless noted).

## 2. Identity, Spaces, and Registries

### UserIdentity (Transient Context)

Meepo stores no user account table. Every authenticated HTTP request resolves a transient `UserIdentity`:

| Field         | Type     | Constraints & Semantics                                   |
| ------------- | -------- | --------------------------------------------------------- |
| `userId`      | `string` | Non-empty stable principal identifier from Authenticator. |
| `displayName` | `string` | Human-readable label attributed on console notes.         |
| `email`       | `string` | Optional email claim from upstream identity provider.     |

### Space & SpaceMember

A **Space** is the sovereign unit of isolation:

| Field            | Type                     | Constraints & Semantics                                                                                       |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `id`             | `string`                 | Primary key.                                                                                                  |
| `name`           | `string`                 | Required, non-empty trimmed display name.                                                                     |
| `description`    | `string?`                | Optional summary injected into space identity prompts.                                                        |
| `timezone`       | `string`                 | Valid IANA timezone (defaults to `'UTC'`); default for cron schedules in this space.                          |
| `promptPreset`   | `'general' \| 'coding'?` | Defaults to `'general'`. `'coding'` appends isolated `git worktree` rules to new sessions/tickets.            |
| `boundWorkerId`  | `string?`                | Enrolled worker hosting this space's `main` sessions. Auto-set when the first enrolled worker registers.      |
| `requiredTags`   | `string[]`               | Worker capability tags required for placement in this space (defaults to `[]`).                               |
| `model`          | `SpaceModelRef?`         | `{ modelId: string, thinkingLevel?: 'low' \| 'high' \| 'max' }`. Falls back to server default model if unset. |
| `repoUrl`        | `string`                 | Optional repository hint surfaced in prompt context (defaults to `''`); never auto-cloned by Meepo.           |
| `defaultBranch`  | `string`                 | Branch hint paired with `repoUrl` (defaults to `'main'`).                                                     |
| `boundChatIds`   | `string[]`               | Read-only compatibility projection aggregating `boundChatIds` across the space's Channels.                    |
| `longTermMemory` | `string`                 | _Legacy compatibility field_ (`''` on new spaces); structured `MemoryEntry` records are authoritative.        |
| `createdAt`      | `integer`                | Creation timestamp.                                                                                           |
| `updatedAt`      | `integer`                | Last metadata mutation timestamp.                                                                             |

**SpaceMember** (`unique (spaceId, userId)`):

- Fields: `spaceId`, `userId`, `role` (`'owner' | 'operator'`), `createdAt`.
- Every space has at least one `owner` (initially its creator). Removing the sole owner is forbidden; ownership changes via atomic ownership transfer.

### Channel (ChannelRegistry)

Each **Channel** represents one IM bot credential bound to a single Space:

| Field            | Type       | Constraints & Semantics                                                              |
| ---------------- | ---------- | ------------------------------------------------------------------------------------ |
| `id`             | `string`   | Primary key.                                                                         |
| `type`           | `'feishu'` | Discriminator reserved for future IM adapters (`slack`, `telegram`, `discord`).      |
| `name`           | `string`   | Required human-readable label for admin management.                                  |
| `appId`          | `string`   | Globally unique bot application ID (`unique (appId)`).                               |
| `appSecret`      | `string`   | Encrypted at rest (AES-256-GCM); omitted from all API read/list projections.         |
| `spaceId`        | `string`   | Foreign reference to an existing `Space`.                                            |
| `allowedOpenIds` | `string[]` | Private-chat sender allowlist; empty (`[]`) admits any user able to message the bot. |
| `boundChatIds`   | `string[]` | Authoritative set of group `chat_id`s routed to `spaceId` through this channel.      |
| `updatedAt`      | `integer`  | Last update timestamp.                                                               |

### ModelRegistry & ModelEntry

Global catalog of OpenAI-completions-compatible model endpoints:

- `ModelRegistry`: `{ defaultModelId?: string, entries: ModelEntry[] }`. Deleting the active `defaultModelId` entry is rejected with conflict until another default is selected.
- `ModelEntry`:
  - `id` (`string`, primary key), `provider` (`string`, e.g. `'openai-completions'`), `model` (`string`, upstream model identifier), `baseUrl` (`http:` or `https:` URL).
  - `apiKey` (`string`): Encrypted at rest (AES-256-GCM); never returned in HTTP responses (`GET /api/models` returns `hasApiKey: true`; `GET /api/model-options` omits `baseUrl` and `apiKey` entirely). Injected transiently into worker dispatch envelopes.
  - `imageInput` (`boolean?`): Whether multimodal image inputs are supported (when omitted, inferred by worker capability rules).

## 3. Workers, Enrollment, and Webhooks

### WorkerNode

| Field             | Type                              | Constraints & Semantics                                                                  |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`              | `string`                          | Worker-generated UUID persisted locally on first boot.                                   |
| `spaceIds`        | `string[]`                        | Authorized spaces derived solely from the worker's active enrollment token.              |
| `hostname`        | `string`                          | Host label reported at registration.                                                     |
| `tags`            | `string[]`                        | Capability/environment labels (e.g. `['linux', 'gpu']`) matched against `requiredTags`.  |
| `maxSlots`        | `integer`                         | Maximum concurrent runs (`1–128`).                                                       |
| `activeSlots`     | `integer`                         | Currently occupied slots (`0..maxSlots`), updated by heartbeats and ticket reservations. |
| `status`          | `'online' \| 'busy' \| 'offline'` | `'busy'` when online with `activeSlots >= maxSlots`; `'offline'` on disconnect/timeout.  |
| `lastHeartbeatAt` | `integer`                         | Server timestamp of most recent registration or heartbeat.                               |
| `version`         | `string`                          | Worker software version string.                                                          |

### WorkerEnrollmentToken

- Fields: `id`, `spaceIds` (non-empty `string[]`), `issuedByUserId`, `label?`, `token` (stored only as `'sha256:<hex>'`; plaintext returned once upon creation), `workerId?`, `expiresAt?`, `revokedAt?`, `createdAt`, `lastUsedAt?`.
- **1:1 Identity Binding**: On first registration, an unrevoked, unexpired token binds permanently to `workerId`. Presenting that token with a different `workerId`, or presenting a different token for an already-bound `workerId`, is rejected.

### Webhook Credentials & Deduplication

- **WebhookToken**: At most one active SHA-256 bearer token hash per `spaceId`. Rotating replaces the hash immediately; revoking deletes it.
- **WebhookRequestRecord**: Keyed by `(spaceId, key)` with `{ fingerprint: sha256(normalizedTicketPayload), ticketId, createdAt }`. Retained for **30 days** (swept hourly) to make `Idempotency-Key` retries idempotent without unbounded storage growth.

## 4. Sessions, Transcripts, and Memory

### Session

| Field              | Type                             | Constraints & Semantics                                                                                      |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`               | `string`                         | Primary key.                                                                                                 |
| `spaceId`          | `string`                         | Owning space.                                                                                                |
| `channelId`        | `string?`                        | Owning IM channel (`''` or absent for console/API-created sessions).                                         |
| `windowId`         | `string?`                        | Derived IM address `{channelId}:{chatId}:{subId}`.                                                           |
| `kind`             | `'main' \| 'thread'`             | `main` follows space rebinds and supports `/new`; `thread` stays pinned to its initial worker.               |
| `chatId`           | `string`                         | IM `chat_id` (or `console:<userId>` for API-opened sessions).                                                |
| `threadId`         | `string`                         | Thread identifier (`senderOpenId` for p2p, `'_group'` for group main stream, `thread_id` for thread).        |
| `anchorMessageId`  | `string?`                        | Root IM message ID used as the reply target for outbound cards and notifications.                            |
| `prewarmMessageId` | `string?`                        | Temporary "processing" message deleted once the first streaming card reply succeeds.                         |
| `boundWorkerId`    | `string?`                        | Pinned worker ID.                                                                                            |
| `status`           | `'active' \| 'idle' \| 'closed'` | Partial uniqueness invariant: at most one non-`closed` session per `(spaceId, channelId, chatId, threadId)`. |
| `createdAt`        | `integer`                        | Creation timestamp.                                                                                          |
| `lastActiveAt`     | `integer`                        | Last turn or binding activity timestamp.                                                                     |

### CanonicalEvent & CompactionCache

- **CanonicalEvent** (`primary key (sessionId, seq)`):
  - `seq`: Strictly monotonic `1..N` integer per session.
  - `type`: `'user_message'` (legacy `'message'` accepted on read) | `'assistant_text'` | `'tool_call'` | `'tool_result'` | `'system_note'` | `'prompt_identity'` | `'prompt_snapshot'`. Streaming deltas (`text_delta`, `thinking_delta`, `tool_execution_update`) are never stored here.
  - `payload`: Structured JSON bounded to `64 KiB` for tool arguments/results. Image inputs store `ImageReference { messageId, fileKey, mimeType?, sizeBytes? }` — never raw image bytes.
  - `timestamp`: Event commit time (`integer`).
  - `runId?`, `clientSeq?`: Unique index on `(runId, clientSeq)` where `runId IS NOT NULL` enforces idempotent worker event ingestion.
- **CompactionCache** (`primary key (sessionId, coversThroughSeq)`):
  - `{ sessionId, coversThroughSeq, summary (≤ 32 KiB), degraded: boolean, createdAt }`.
  - Disposable prefix summary cache accelerating cold recovery; raw `CanonicalEvent` rows are never mutated or deleted, and `degraded = true` caches are excluded from snapshot reuse so future cold starts retry from raw events.

### MemoryEntry

Keyed uniquely by `(spaceId, path)`:

| Field         | Type          | Constraints & Semantics                                                                                     |
| ------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `spaceId`     | `string`      | Owning space (max **500** non-deleted entries per space).                                                   |
| `path`        | `string`      | `1–5` slash-separated segments, each matching `[a-z0-9][a-z0-9_-]{0,63}`.                                   |
| `description` | `string`      | Required single-line summary (`1–200` chars, no CR/LF).                                                     |
| `keywords`    | `string[]`    | `0–10` non-empty strings, each `1–32` chars.                                                                |
| `content`     | `string`      | UTF-8 Markdown body (`≤ 64 KiB`).                                                                           |
| `revision`    | `integer`     | Monotonic per `(spaceId, path)` starting at `1`. Preserved across deletion via tombstone (`deleted` flag).  |
| `pinned`      | `boolean`     | Prioritized in directory map ordering and search ranking.                                                   |
| `updatedAt`   | `integer`     | Last write timestamp.                                                                                       |
| `updatedBy`   | `MemoryActor` | `{ kind: 'console', userId }` or `{ kind: 'agent', sessionId, authorId? }` (`ticket:<id>` for ticket runs). |

## 5. Execution Entities and Transactional Queues

### Ticket & TicketReceipt

- **Ticket**:
  - `id`, `spaceId`, `title` (`1–200` chars), `objective` (`1–32,000` chars), `contextSummary?` (`≤ 32,000` chars), `requiredTags` (`string[]`, defaults to `space.requiredTags`), `originSessionId?` (must belong to `spaceId`), `idempotent` (`boolean`, defaults to `false`).
  - `attempt` (`integer`, `0` before first claim, `1..3` across dispatches), `assignedWorkerId?`.
  - `status`: `'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'manual_review'`.
  - `terminalReason?`: `'unclaimed' | 'error' | 'max_attempts' | 'abandoned' | 'cancelled'`.
  - `result?`: `{ summary: string, branch?: string, prUrl?: string, commitSha?: string }` (`summary` is canonical; repository fields are optional legacy metadata).
  - `pendingSince` (start of current `pending` interval; governs 24h unclaimed timeout), `createdAt`, `updatedAt`, `completedAt?`.
- **TicketReceipt**: Durable outbox record `{ runId (dedup key), sessionId, content, timestamp, delivered }` guaranteeing at-least-once delivery of terminal or `manual_review` notices back to `originSessionId`.

### Schedule & ScheduleFire

- **Schedule**:
  - `id`, `spaceId`, `createdByUserId` (initiating user ID, or `'agent'` for machine turns), `createdAt`, `lastFiredAt?`.
  - `timing`: `{ kind: 'at', at: integer }` or `{ kind: 'cron', expression: string, timezone?: string }`.
  - `action`: `{ kind: 'create_ticket', objective, contextSummary?, requiredTags?, originSessionId? }` or `{ kind: 'resume_session', sessionId, prompt }` (capped at **50** active `resume_session` schedules per session).
  - `status`: `'active' | 'done' | 'deleted'`.
- **ScheduleFire**: `{ id ('<scheduleId>:<timestamp>'), scheduleId, workId, createdAt }`, recorded atomically with the materialized Ticket or Turn.

### Run & RunEvent

- **Run**:
  - `id`, `work` (`{ kind: 'ticket', ticketId }` | `{ kind: 'turn', turnRef: { sessionId, sourceId } }`), `attempt` (`1` for turns, `1..3` for tickets), `workerId?`.
  - `status`: `'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'merged' | 'dropped'`.
  - `leaseExpiresAt?`, `terminalReason?` (`'worker_lost' | 'lease_lost' | 'interrupted' | 'cancelled' | 'error' | 'timeout' | ...`), `lastClientSeq` (monotonic ACK watermark, starts at `0`).
  - `initiatorIds` (`string[]`, all user `open_id`/`userId`s credited with initiating a single or merged turn; empty for machine turns), `mergedSourceIds` (`string[]`), `mergedIntoRunId?`.
  - `usage?`: `{ inputTokens: integer, outputTokens: integer, costUsd?: number }` (present only when reported by the model provider).
  - `createdAt`, `startedAt?`, `completedAt?`.
- **RunEvent** (`primary key (runId, clientSeq)`): Non-delta worker events (`run_started`, `tool_execution_start`, `tool_execution_end`, `assistant_text`, `context_note`, terminal events) persisted for ticket execution replay and lease-expiry tool inspection.

### Reliability Inboxes, Queues, and Retention Summary

| Store / Artifact                    | Purpose                                                            | Retention Policy                           |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `CanonicalEvent` / `Run` / `Ticket` | Authoritative audit and execution history                          | Permanent (no automatic server expiry)     |
| `DispatchQueue`                     | Server-side turn envelopes awaiting online worker (no raw secrets) | Deleted upon terminal settlement or merge  |
| `InboundInbox`                      | Raw normalized IM events persisted before domain processing        | Deleted immediately upon `TxEnqueueTurn`   |
| `ProcessedMessages`                 | `(channelId, messageId)` durable IM deduplication ledger           | Swept after **7 days**                     |
| `WebhookRequests`                   | `(spaceId, key)` idempotency ledger                                | Swept after **30 days**                    |
| `CardOutbox` / `MessageOutbox`      | Crash-resilient outbound IM card and text reply projections        | Marked complete once delivered and settled |
| Worker task directories             | `<sessionsDir>/<id>`, `<ticketsDir>/<id>/attempt-N`                | Reclaimed after **7 days** of inactivity   |
| Worker media cache                  | `<sessionsDir>/.media/<sha256>` original downloaded images         | Retained across task-directory reclamation |
