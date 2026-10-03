# Server Control Plane Architecture

The `meepo-server` application coordinates multi-chat inbound traffic, manages spaces, persists long-term memory and session transcripts, and dispatches workload to bound workers.

## Core Modules

### 1. Feishu Gateway (singleton)

- Runs as **exactly one instance** (the Feishu WebSocket long connection delivers each event to one random connection of the app, so multiple instances would split events). The whole control plane is single-replica in this phase — the gateway singleton forces it; horizontal scale-out is a documented future goal (connection ownership, shared queue, concurrency control), gated on the Postgres migration.
- Ingests events via the Feishu WebSocket long connection (no public endpoint required); webhook ingestion is the upgrade path for multi-instance deployments.
- Persists normalized incoming messages in an inbox before external I/O; failures retry after reconnect/restart.
- Deduplicates durably: inbound `message_id`s are recorded in a `processed_messages` table, committed in the same transaction as the work they create — deduplication survives restarts within its retention window; rows older than 7 days are swept. (The long connection redelivers messages after reconnects.)
- Resolves inbound routing: `chat_id` → Space (via the channel that received the event), message → window and session (see `specs/features/interactive-session.md`).
- Authorizes card Stop callbacks against the persisted run initiators (all authors of a merged turn), not the session creator; see Card Streamer below.
- Feishu app credentials live in the **ChannelRegistry** (`{ id, type: 'feishu', appId, appSecret }`), not in server-global config; each channel stores `spaceId` and `boundChatIds`; one space may own multiple channels. Space projections are not the routing authority.
- Manages one long connection per channel at runtime (connections are added and removed as the registry changes); all gateway caches (dedup, thread prewarm, window sessions) are keyed by `channelId`, and credential rotation reconnects only the affected channel.

### 2. Space & Memory Manager

- Maintains configuration for each Space:
  - Allowed worker tags (e.g. `[macos, dev, private]`).
  - Holds the space worker binding (`boundWorkerId`) — see `specs/features/space-and-chat.md` for its default, migration, and pinning semantics.
- Owns structured memory entries and optimistic revisions. [Memory](../features/memory.md) defines retrieval, tombstones, limits and the directory map; worker prompt refresh timing is defined in [worker data plane](worker-data-plane.md).

### 3. Session Store (Single Source of Truth)

- Persists the authoritative session event stream as one ordered log per session — canonical events `{ seq, type, payload, timestamp, runId? }` (`user_message` / `assistant_text` / `tool_call` / `tool_result` / `system_note` / `prompt_identity` / `prompt_snapshot`; tool pairs matched by `(runId, toolCallId)`) — plus a materialized current-state projection for routing and queries.
- Durability boundary: events are appended in transactional segments during execution, never buffered to turn boundaries; delta frames are transport, not storage. A worker cold-start resumes from the last confirmed `seq`, so a crash never loses confirmed events.
- Hot-session consistency: executable ticket receipts and console injections arrive through durable `turn.dispatch`; history-only notes use `context.append`. Both appear in the authoritative transcript.
- Compaction summaries are rebuildable caches: the raw event log is never overwritten, and tool call/result pairs are never split.
- Event dedup: the worker stamps every event with a per-run monotonic `clientSeq`; the server dedups on `(runId, clientSeq)`, ACKs only after persistence, and on reconnect hands the worker its `lastConfirmedClientSeq` so unacknowledged events replay exactly once.
- The two server→worker channels stay strictly separate: `turn.dispatch` delivers executable work (user messages, console injections, ticket receipts — with delivery semantics); `context.append` writes history-only notes that need no response (e.g. the post-rebind migration notice). Executable content never travels via `context.append`.
- Run creation and queued input are durable before network dispatch. Persisted `run_started` is the execution-start boundary: before it, the same delivery may replay; after it, confirmed history can be reconstructed, but an unknown external tool outcome cannot be reconstructed or safely repeated merely from a transcript.
- Schema and protocol breaking changes apply through the migration framework; migrations never wipe existing data.
- Usage: `run_completed.usage` is persisted on each Run. `GET /api/spaces/:id/usage` sums session runs and ticket attempts for that space under membership authorization; the space console displays input/output tokens and provider-reported costs. Missing usage/cost reports remain explicitly unreported rather than inferred as zero.
- Event and ticket execution logs have no automatic expiry. There is no general console purge API. Worker directory and media retention are defined in [worker data plane](worker-data-plane.md); server references do not guarantee Feishu source bytes remain downloadable forever.

### 4. Dispatcher & Load Balancer

- Two dispatch paths share one pipeline: **ticket dispatch** (new execution context) and **turn dispatch** (existing session context).
- Session routing is binding lookup, not selection: a session routes to its persisted binding; explicit main-session rebind changes it.
- Creation-time binding depends on session type: main sessions (private-chat and group-main conversations) bind to the space's `boundWorkerId`; thread sessions pick a randomly chosen eligible worker — a routing-policy hook is reserved for future identity-aware placement (e.g. preferring the triggering user's own machine).
- After initial thread placement, only tickets involve per-dispatch worker selection: any enrolled, tag-matched worker with a free slot, preferring the least-loaded.
- When the bound worker is offline, session messages queue server-side and coalesce; delivery resumes when the worker reconnects under its stable `workerId` and queued dispatches flush.
- A periodic sweep retries pending tickets as worker slots free up. Failed reservation on a stale heartbeat advances to the next eligible worker. Queue, receipt and schedule errors are isolated per item so one invalid space configuration does not stall other spaces.

### 5. Card Streamer

- Aggregates worker stream events into full-snapshot render frames (not deltas), keeping the core IM-agnostic and immune to out-of-order frames.
- Card structure: `[collapsible thinking panel] + [answer markdown] + [tool pills] + [stop button (streaming only)]`; the stop button is removed and streaming mode is closed at terminal state.
- Throttles CardKit patch calls (~0.5s) to adhere to Feishu rate limits while providing smooth streaming output.
- Sends thread messages as `reply_in_thread` replies to the session's anchor (root) message; creating a message with `receive_id_type=thread_id` is rejected by the API, and `reply_in_thread` is rejected on messages already inside a thread (error 99992354).
- **No content, no card**: proactive/machine turns without visible output stay silent — no placeholder card is created.
- Card sends use persisted projections and pending reply metadata. Recovery queries Feishu using the same app identity before retrying an uncertain send; UUID deduplication adds a second guard. This addresses crash/retry duplication within the platform’s query and deduplication behavior, not an unconditional exactly-once external delivery guarantee.
- 'Has content' means visible assistant text or thinking — tool calls alone never open a card; machine turns that error out stay silent (logged only). Past 30,000 characters of markdown the card rolls over to a fresh one. Card updates carry a monotonic `sequence` and are applied through a per-run serial queue so stale frames never overwrite newer ones. Card action callbacks carry the `runId` — callbacks for terminal runs are ignored — and the stop action is limited to the turn's initiating user; the triggerer is persisted on the Run (a merged turn credits all authors), space members may also stop from the console, and a missing triggerer record fails closed.
- Tool pills show the tool name and status only — never parameters or results (a bash command may carry secrets); pills are ordered by event time and capped at 10 per card.
- A user turn that fails before producing any content yields a brief error message in the window; machine turns stay silent on failure (logged only).

### 6. Scheduler

- Agent-created schedules use the first persisted run initiator as `createdByUserId` (the first author in a merged turn); machine turns use `agent`. Worker-supplied identity fields are ignored.
- Owns the single scheduling entity **Schedule**, with two action kinds: `create_ticket` (fire creates a ticket) and `resume_session` (fire dispatches a turn into the bound session). See `specs/features/triggers-and-scheduling.md`.
- Stores durable, server-side records; an in-process fire loop dispatches due entries.
- Missed fires coalesce into a single delivery with a coalesced count; per-job deterministic jitter avoids thundering herds.
- Dispatch is at-least-once: when no worker is available, the fire queues (coalescing) rather than dropping.

### 7. Auth

- Exposes an `Authenticator` port that extracts a normalized `Identity { userId, displayName, email }` from incoming requests.
- An SSO adapter (local verification of the edge-injected JWT) is planned; a header-based local adapter serves development. Neither leaks into business code. The listener defaults to `127.0.0.1`; production rejects header authentication unless `MEEPO_ALLOW_INSECURE_HEADER_AUTH=1` explicitly opts into an isolated deployment.
- Business code reads identity from request context only — never from request payloads. Supplied path/query/body `spaceId`s must be valid and consistent; existing resources are authorized against their stored space. A query parameter cannot override the authorization target of a create body.
- Authorization is checked against space membership: a per-space role (`owner` or `operator`) keyed by `userId`. A separate **admin** role exists only for global, non-space configuration (e.g. the model and channel registries) and grants no visibility into private spaces. MEEPO keeps no account system.
- The **admin** role is bootstrapped from the server env `MEEPO_ADMIN_USER_IDS` (comma-separated userIds) — the only generic bootstrap path; platform-level role providers (e.g. moongate) replace it as an adapter detail when integrated.
- `owner`-exclusive operations: delete space, remove member, transfer ownership; every other space administration action is available to `operator`. Enrollment tokens are issued by any space member.
- Secrets at rest: channel `appSecret`s and model `apiKey`s are AES-256-GCM encrypted with the server-side env master key `MEEPO_SECRET_KEY` (required in production; dev mode falls back to plaintext with a loud warning). Enrollment tokens are stored as SHA-256 hashes only; the dispatch queue carries credential references resolved at delivery, never raw keys; registry read/list responses omit stored secrets. Enrollment and webhook issuance return their newly generated token once. Model API keys are transient dispatch data visible to worker owners. Channel app secrets and tenant tokens never leave the server; `media.read` checks worker/session affinity and an exact persisted image reference before fetching at most 10 MiB. The media downloader caches tenant tokens per channel and credential fingerprint, with an expiry margin (10% of lifetime, capped at 60 seconds), coalesces concurrent authentication, and refreshes after credential rotation. Failed authentication is retryable; an HTTP 401 invalidates the matching cached token for the next download. Tokens without an expiry are not reused. Image bytes are buffered transiently and returned as base64, not streamed or persisted.
- Authenticated console callers use `GET /api/model-options` for model IDs/capabilities without credentials or endpoint configuration; `GET/PUT/DELETE /api/models` and the channel registry require global admin.
- The worker channel does not use this layer: workers authenticate with enrollment tokens.

### 8. Console

The console is the management and observation surface (not a workspace): pages for Spaces, Workers, Tickets, Schedules, Sessions (transcripts), Models, Channels, and Memory. Transcript viewing reads a snapshot and follows increments over WebSocket, resuming by `seq` after a reconnect. A console member may inject a **mailbox message** into a session: delivered with `wait` semantics (never interrupts), recorded in the event stream as a `system_note` attributed to the console user, with the reply going to the session's own window. All space-scoped console operations require space membership; model choices come from the credential-free `/api/model-options` endpoint; the global registries (Models, Channels) require the admin role. There is no read-only role.

## Layering

The server follows the layering conventions in `specs/architecture/backend-layering.md`: transport calls domain services, domain depends on persistence ports, stores implement those ports; ports are defined at the consumer, composition wired manually in `bootstrap.ts`.

### Transaction boundaries and cancellation contract

Domain services choose state transitions; store adapters atomically commit the affected entities. Production composition uses SQLite transaction adapters. In-memory repositories are test doubles and do not reproduce every cross-entity effect.

| Operation                       | Atomic effects                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Incoming turn / `TxEnqueueTurn` | Channel/message dedup, run, transcript input and dispatch queue. Dispatched envelopes replay unchanged; only never-dispatched inputs coalesce server-side.                                       |
| Ticket claim / `TxClaimTicket`  | Pending ticket claim, incremented attempt, worker capacity reservation and run.                                                                                                                  |
| Worker event / `TxAppend`       | Per-run event sequence, canonical transcript or ticket execution event, run/ticket projection and any completion receipt. ACK follows commit.                                                    |
| Lease expiry / `TxExpire`       | Fence the expired run; transition the matching ticket attempt to pending, manual_review or failed. Auto-retry resets `pendingSince` in the same transaction; review/failure creates its receipt. |
| Schedule fire / `TxFire`        | Schedule cursor/status, fire identity and new ticket or queued session turn.                                                                                                                     |
| Session reset / `TxReset`       | Close old main, fence all its queued/dispatched/running runs, cancel resume schedules, replace window mapping, dedup command and enqueue confirmation.                                           |
| Space rebind / `TxRebind`       | Interrupt running main-session runs, move their queued/dispatched inputs, update space/session binding and append migration notes. Threads remain untouched.                                     |
| Session close / `TxClose`       | Close session, fence its nonterminal runs, delete dispatch queue and cancel resume schedules. Metadata saves also guard expected status/binding against stale updates.                           |
| Ticket terminal save            | Expected ticket status/attempt check, ticket write, related run fencing and deduplicated origin receipt, as detailed below.                                                                      |

**`SqliteTicketRepository.save()` is not a single-row-only save.** For a ticket saved as `completed`, `failed` or `cancelled`, it also marks related `queued/dispatched/running` runs `failed`, with `terminal_reason = ticket.terminalReason ?? ticket.status`; already terminal runs remain unchanged. It enqueues an origin receipt when `originSessionId` exists, keyed by `ticket:<id>:<attempt>:<status>`. Normal worker completion uses `TxAppend`, which completes its run and updates the ticket/receipt together.

The cancel HTTP route accepts pending, claimed, running and manual_review tickets. Repeated cancellation returns the existing cancelled ticket without rewriting timestamps or creating another receipt, then resends abort. Completed/failed tickets are not overwritten. The route first awaits this save, then calls `stopTicketExecutions()`. At that point cancelled runs are already terminal in storage. The sender selects runs by `terminalReason === 'cancelled'` and sends `run.abort` to stop their live worker execution. Filtering only nonterminal runs here would skip the abort. Fencing makes late events invalid independently of successful notification delivery; the WebSocket abort is not part of the database transaction.

The current `TicketRepository` interface does not express all these effects, and its memory adapter only saves ticket rows. Any port refactor or new database adapter must preserve the production contract and its HTTP + SQLite cancellation regression; making the transaction port explicit remains cleanup work.

Outbound card recovery persists IDs and reply-attempt metadata before retrying, reserves sequences before network updates, and retains the original run cancellation identity across continuation cards. Receipt dispatch uses a stable ingress identity; a closed origin receives a transcript-only note.

### Bounded history and webhook ingestion

- Lease sweeps query indexed nonterminal expired runs and timed-out pending tickets. Reconciliation queries the calling worker's active runs plus explicitly reported IDs. Usage totals are aggregated in SQL for the requested space's resources. Session event increments apply `seq > afterSeq` in SQL and return at most 500 records; consumers continue with the last returned `seq`.
- Card recovery queries running runs, pending projections and terminal runs since its previous completion-time watermark. Startup performs a historical rebuild once. Lease-expired user turns converge to a failed, non-streaming card with failure text through this same recovery loop (nominal interval 2 seconds), even without an immediate render callback.
- Cold worker snapshots opt into 50-event pages and a compatible compaction cache. `session_compactions` stores immutable `{summary,coversThroughSeq}` prefixes. Only caches strictly before the snapshot boundary may be used; the tail comes from original events. Raw logs remain unchanged. A degraded cache atomically adds a `system_note` explaining lost model context; it does not assert that the original history was deleted.
- Webhook request idempotency is separate from attempt retry safety. `TicketRepository.create(ticket, requestKey)` atomically stores the space/key, normalized payload hash and new ticket. A duplicate returns the current original ticket; changed payloads conflict. Keys do not expire automatically. The endpoint has a 128 KiB body limit, per-field limits and an in-memory 60/minute/space rate limit; this is a single-instance gate, not a multi-replica quota system.
