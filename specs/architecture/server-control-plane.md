# Server Control Plane Architecture

The `meepo-server` application coordinates multi-chat inbound traffic, manages spaces, persists long-term memory and session transcripts, and dispatches workload to bound workers.

## Core Modules

### 1. Feishu Gateway (singleton)

- Runs as **exactly one instance** (the Feishu WebSocket long connection delivers each event to one random connection of the app, so multiple instances would split events). The whole control plane is single-replica in this phase — the gateway singleton forces it; horizontal scale-out is a documented future goal (connection ownership, shared queue, concurrency control), gated on the Postgres migration.
- Ingests events via the Feishu WebSocket long connection (no public endpoint required); webhook ingestion is the upgrade path for multi-instance deployments.
- Deduplicates durably: inbound `message_id`s are recorded in a `processed_messages` table, committed in the same transaction as the work they create — exactly-once ingest across restarts; rows older than 7 days are swept. (The long connection redelivers messages after reconnects.)
- Resolves inbound routing: `chat_id` → Space (via the channel that received the event), message → window and session (see `specs/features/interactive-session.md`).
- Binds card action callbacks to the session's origin user, rejecting forged or cross-user actions.
- Feishu app credentials live in the **ChannelRegistry** (`{ id, type: 'feishu', appId, appSecret }`), not in server-global config; a space may bind multiple channels (`boundChannelIds`).
- Manages one long connection per channel at runtime (connections are added and removed as the registry changes); all gateway caches (dedup, thread prewarm, window sessions) are keyed by `channelId`, and credential rotation reconnects only the affected channel.

### 2. Space & Memory Manager

- Maintains configuration for each Space:
  - Allowed worker tags (e.g. `[macos, dev, private]`).
  - Holds the space worker binding (`boundWorkerId`) — see `specs/features/space-and-chat.md` for its default, migration, and pinning semantics.
- **Space memory is an entry set, not a blob**: entries carry `path` / `description` / `keywords` / `content` / `revision`. Retrieval is FTS5 **trigram** full-text over path, description, keywords, and content — substring matching that works for Chinese, with `pg_trgm` as the Postgres migration equivalent; `MemorySearch` is substring-ranked, never semantic (an `embedding` column is reserved for later vector search). Deletions are tombstones: a recreated path continues its `revision` sequence rather than restarting. The prompt receives only a directory-level **Memory Map** (folder counts + top keywords), snapshotted at session creation and placed at the end of the system prompt — it may go stale; the five memory tools (`MemoryList` / `MemorySearch` / `MemoryRead` / `MemoryWrite` / `MemoryDelete`, writes guarded by `expected_revision`) always return current data. Both the agent and console may modify memory, with curation rules left to the user.

### 3. Session Store (Single Source of Truth)

- Persists the authoritative session event stream as one ordered log per session — canonical events `{ seq, type, payload, timestamp, runId? }` (`user_message` / `assistant_text` / `tool_call` / `tool_result` / `system_note` / `prompt_snapshot`; tool pairs matched by `toolCallId`) — plus a materialized current-state projection for routing and queries.
- Durability boundary: events are appended in transactional segments during execution, never buffered to turn boundaries; delta frames are transport, not storage. A worker cold-start resumes from the last confirmed `seq`, so a crash never loses confirmed events.
- Hot-session consistency: server-side writes into a live session (ticket receipts, console injections) are pushed to the bound worker as `context.append` notifications, keeping warm and cold sessions on the same history.
- Compaction summaries are rebuildable caches: the raw event log is never overwritten, and tool call/result pairs are never split.
- Event dedup: the worker stamps every event with a per-run monotonic `clientSeq`; the server dedups on `(runId, clientSeq)`, ACKs only after persistence, and on reconnect hands the worker its `lastConfirmedClientSeq` so unacknowledged events replay exactly once.
- The two server→worker channels stay strictly separate: `turn.dispatch` delivers executable work (user messages, console injections, ticket receipts — with delivery semantics); `context.append` writes history-only notes that need no response (e.g. the post-rebind migration notice). Executable content never travels via `context.append`.
- A dispatch is durable once its `run_started` event is persisted; everything before that point is re-dispatchable, everything after is recoverable by `seq`.
- Schema and protocol breaking changes apply through the migration framework; migrations never wipe existing data.
- Retention: the event log and ticket execution streams are permanent by default (an admin may purge manually); media files live as long as the events referencing them; working directories on workers are reclaimed after 7 days or on `session.closed`.

### 4. Dispatcher & Load Balancer

- Two dispatch paths share one pipeline: **ticket dispatch** (new execution context) and **turn dispatch** (existing session context).
- Session routing is binding lookup, not selection: a session always routes to the worker it was bound to at creation.
- Creation-time binding depends on session type: main sessions (private-chat and main-window conversations) bind to the space's `boundWorkerId`; thread sessions pick a randomly chosen eligible worker — a routing-policy hook is reserved for future identity-aware placement (e.g. preferring the triggering user's own machine).
- Only tickets involve worker selection: any enrolled, tag-matched worker with a free slot, preferring the least-loaded.
- When the bound worker is offline, session messages queue server-side and coalesce; delivery resumes when the worker reconnects under its stable `workerId` and queued dispatches flush.
- A periodic sweep retries pending tickets as worker slots free up.

### 5. Card Streamer

- Aggregates worker stream events into full-snapshot render frames (not deltas), keeping the core IM-agnostic and immune to out-of-order frames.
- Card structure: `[collapsible thinking panel] + [answer markdown] + [tool pills] + [stop button (streaming only)]`; the stop button is removed and streaming mode is closed at terminal state.
- Throttles CardKit patch calls (~0.5s) to adhere to Feishu rate limits while providing smooth streaming output.
- Sends thread messages as `reply_in_thread` replies to the session's anchor (root) message; creating a message with `receive_id_type=thread_id` is rejected by the API, and `reply_in_thread` is rejected on messages already inside a thread (error 99992354).
- **No content, no card**: proactive/machine turns without visible output stay silent — no placeholder card is created.
- Outbound sends are idempotent: an outbox row is persisted (pending) before every send and marked sent after; on startup, pending rows are reconciled by querying Feishu before deciding to resend — a crash never produces duplicate cards.
- 'Has content' means visible assistant text or thinking — tool calls alone never open a card; machine turns that error out stay silent (logged only). Past ~30,000 characters of markdown the card rolls over to a fresh one. Card updates carry a monotonic `sequence` and are applied through a per-run serial queue so stale frames never overwrite newer ones. Card action callbacks carry the `runId` — callbacks for terminal runs are ignored — and the stop action is limited to the turn's initiating user; the triggerer is persisted on the Run (a merged turn credits all authors), space members may also stop from the console, and a missing triggerer record fails closed.
- Tool pills show the tool name and status only — never parameters or results (a bash command may carry secrets); pills are ordered by event time and capped at 10 per card.
- A user turn that fails before producing any content yields a brief error message in the window; machine turns stay silent on failure (logged only).

### 6. Scheduler

- Owns the single scheduling entity **Schedule**, with two action kinds: `create_ticket` (fire creates a ticket) and `resume_session` (fire dispatches a turn into the bound session). See `specs/features/triggers-and-scheduling.md`.
- Stores durable, server-side records; an in-process fire loop dispatches due entries.
- Missed fires coalesce into a single delivery with a coalesced count; per-job deterministic jitter avoids thundering herds.
- Dispatch is at-least-once: when no worker is available, the fire queues (coalescing) rather than dropping.

### 7. Auth

- Exposes an `Authenticator` port that extracts a normalized `Identity { userId, displayName, email }` from incoming requests.
- An SSO adapter (local verification of the edge-injected JWT) is planned; a header-based local adapter serves development. Neither leaks into business code.
- Business code reads identity from request context only — never from request payloads.
- Authorization is checked against space membership: a per-space role (`owner` or `operator`) keyed by `userId`. A separate **admin** role exists only for global, non-space configuration (e.g. the model and channel registries) and grants no visibility into private spaces. MEEPO keeps no account system.
- The **admin** role is bootstrapped from the server env `MEEPO_ADMIN_USER_IDS` (comma-separated userIds) — the only generic bootstrap path; platform-level role providers (e.g. moongate) replace it as an adapter detail when integrated.
- `owner`-exclusive operations: delete space, remove member, transfer ownership; every other space administration action is available to `operator`. Enrollment tokens are issued by any space member.
- Secrets at rest: channel `appSecret`s and model `apiKey`s are AES-256-GCM encrypted with the server-side env master key `MEEPO_SECRET_KEY` (required in production; dev mode falls back to plaintext with a loud warning). Enrollment tokens are stored as SHA-256 hashes only; the dispatch queue carries credential references resolved at delivery, never raw keys; API responses never include secret fields.
- The worker channel does not use this layer: workers authenticate with enrollment tokens.

### 8. Console

The console is the management and observation surface (not a workspace): pages for Spaces, Workers, Tickets, Schedules, Sessions (transcripts), Models, Channels, and Memory. Transcript viewing reads a snapshot and follows increments over WebSocket, resuming by `seq` after a reconnect. A console member may inject a **mailbox message** into a session: delivered with `wait` semantics (never interrupts), recorded in the event stream as a `system_note` attributed to the console user, with the reply going to the session's own window. All space-scoped console operations require space membership; the global registries (Models, Channels) require the admin role. There is no read-only role.

## Layering

The server follows the layering conventions in `specs/architecture/backend-layering.md`: `transport → domain → store` one-way, ports defined at the consumer, composition wired manually in `bootstrap.ts`.
