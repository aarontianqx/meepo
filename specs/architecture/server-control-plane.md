# Server Control Plane Architecture

The `meepo-server` application coordinates multi-chat inbound traffic, manages spaces, persists long-term memory and session transcripts, and dispatches workload to bound workers.

## Core Modules

### 1. Feishu Gateway

- Ingests events primarily via the Feishu WebSocket long connection (no public endpoint required); webhook ingestion is an alternative behind the same handler pipeline.
- Deduplicates by `message_id` with a TTL cache — the long connection redelivers messages after reconnects.
- Verifies authenticity: webhook mode verifies request signatures; the long connection is authenticated by the app credentials themselves.
- Resolves inbound routing: `chat_id` → Space, message → window and session (see `specs/features/interactive-session.md`).
- Binds card action callbacks to the originating user, rejecting forged or cross-user actions.

### 2. Space & Memory Manager

- Maintains configuration for each Space:
  - Repository URL, default branch, target languages.
  - Allowed worker tags (e.g. `[macos, dev, private]`).
  - Space Long-Term Memory: persistent business conventions, architectural rules, and curated knowledge summaries.
- Holds the space worker binding (`boundWorkerId`) — see `specs/features/space-and-chat.md` for its default, migration, and pinning semantics.
- Periodically accepts proposed knowledge deltas from completed tasks and merges them into the persistent space memory.

### 3. Session Store (Single Source of Truth)

- Persists the authoritative session event stream: user and agent messages, tool executions, and durable state records as one ordered log per session, plus a materialized current-state projection for routing and queries.
- Buffers incoming stream deltas per turn and persists them at turn boundaries.
- Provides full snapshots for worker cold-starts (incremental sync is a later optimization).

### 4. Dispatcher & Load Balancer

- Two dispatch paths share one pipeline: **ticket dispatch** (new execution context) and **turn dispatch** (existing session context).
- Session routing is binding lookup, not selection: a session always routes to the worker it was bound to at creation.
- Creation-time binding depends on session type: main sessions (private-chat and main-window conversations) bind to the space's `boundWorkerId`; thread sessions pick a randomly chosen eligible worker — a routing-policy hook is reserved for future identity-aware placement (e.g. preferring the triggering user's own machine).
- Only tickets involve worker selection: any enrolled, tag-matched worker with a free slot, preferring the least-loaded.
- When the bound worker is offline, session messages queue server-side and coalesce; delivery resumes when the worker reconnects under its stable `workerId` and queued dispatches flush.
- A periodic sweep retries pending tickets as worker slots free up.

### 5. Card Streamer

- Aggregates worker stream events into full-snapshot render frames (not deltas), keeping the core IM-agnostic and immune to out-of-order frames.
- Throttles CardKit patch calls (~0.5s) to adhere to Feishu rate limits while providing smooth streaming output.
- Sends thread messages as `reply_in_thread` replies to the session's anchor (root) message; creating a message with `receive_id_type=thread_id` is rejected by the API, and `reply_in_thread` is rejected on messages already inside a thread (error 99992354).

### 6. Scheduler

- Owns the single scheduling entity **Schedule**, with two action kinds: `create_ticket` (fire creates a ticket) and `resume_session` (fire dispatches a turn into the bound session). See `specs/features/triggers-and-scheduling.md`.
- Stores durable, server-side records; an in-process fire loop dispatches due entries.
- Missed fires coalesce into a single delivery with a coalesced count; per-job deterministic jitter avoids thundering herds.
- Dispatch is at-least-once: when no worker is available, the fire queues (coalescing) rather than dropping.

### 7. Auth

- Exposes an `Authenticator` port that extracts a normalized `Identity { userId, displayName, email }` from incoming requests.
- An SSO adapter (local verification of the edge-injected JWT) is planned; a header-based local adapter serves development. Neither leaks into business code.
- Business code reads identity from request context only — never from request payloads.
- Authorization is checked against space membership: a per-space role (`owner` or `manager`) keyed by `userId`; MEEPO keeps no account system.
- The worker channel does not use this layer: workers authenticate with enrollment tokens.

## Layering

The server follows the layering conventions in `specs/architecture/backend-layering.md`: `transport → domain → store` one-way, ports defined at the consumer, composition wired manually in `bootstrap.ts`.
