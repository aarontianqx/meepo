# Server Control Plane Architecture

> **Scope**: Specifies the internal subsystems, security and secret-management invariants, cross-entity atomic transaction boundaries, and background reconciliation loops of `meepo-server`. External HTTP/WebSocket route schemas live in [Control Plane API](control-plane-api.md); wire frames with workers live in [Worker Protocol](worker-protocol.md).

## 1. Core Subsystems

### 1.1 Channel Gateway (Inbound IM Ingestion)

- **Dynamic per-channel connections**: Manages one outbound long-lived event stream per registered `Channel` in `ChannelRegistry`. Adding, rotating, or deleting a channel dynamically starts, reconnects, or closes only that channel's connection; all runtime caches (deduplication, window-to-session lookup, thread prewarm state) are partitioned by `channelId` so colliding provider message IDs across bots never interfere.
- **Crash-safe inbox and durable deduplication**: Incoming IM events are written to a persistent `InboundInbox` before external I/O and replayed on restart if interrupted. Finalized `message_id`s commit to `ProcessedMessages` in the **same atomic transaction** as the work they create (`TxEnqueueTurn` or `TxReset`), surviving restarts across a 7-day retention window to absorb reconnect redeliveries.
- **Downtime catch-up**: On start, each channel re-reads the last 24 hours of its bound group chats and feeds the messages through the same inbox and decision chain (commands and unreadable types are skipped); durable deduplication makes the replay idempotent (see [Interactive Session](../features/interactive-session.md)).
- **Routing authority**: Resolves `(channelId, chatId)` to the channel's bound `Space`, evaluates respond gates, and maps the conversation window to a `Session` (see [Interactive Session](../features/interactive-session.md)). `ChannelRegistry` is the sole routing authority; space-level `boundChatIds` is a read projection.
- **Card action authorization**: Verifies interactive card `Stop` (`abort_run`) callbacks against the persisted `Run.initiatorIds` (every author of a single or merged turn) and matching `channelId` — never against the session creator, and failing closed if `initiatorIds` is empty or terminal.

### 1.2 Space & Memory Manager

- Owns `Space` configuration, membership roles, worker binding (`boundWorkerId`), and space-scoped `MemoryEntry` storage.
- Enforces optimistic concurrency (`expected_revision`) and tombstone-backed monotonic revisions across both Console HTTP writes and worker `memory.call` RPCs (see [Space Memory](../features/memory.md)).

### 1.3 Session & Execution Journal Store

- **Single source of truth**: Persists each session's ordered `CanonicalEvent` log (`seq = 1..N`) alongside materialized `Session`, `Run`, and `Ticket` state projections.
- **Incremental durability**: Worker events commit in atomic per-event transactions (`stream.append`) during execution rather than buffering until turn completion. Streaming deltas (`text_delta`, `thinking_delta`, `tool_execution_update`) are acknowledged for transport ordering and live rendering but excluded from canonical storage.
- **Sequence deduplication**: Deduplicates worker events on `(runId, clientSeq)`, returning the committed `StreamAck` ONLY after durable write, and reports `lastConfirmedClientSeq` during `run.reconcile` so unacknowledged events replay without duplication.
- **Strict downstream channel separation**:
  - `turn.dispatch` carries executable inputs requiring an agent turn (user messages, console mailbox injections, ticket receipts, schedule wakeups).
  - `context.append` carries passive, history-only canonical events (`system_note`, such as post-rebind migration notices) applied between turns without triggering model execution.
    _Rationale: Mixing executable prompts and passive history notes on one channel either triggers unintended model turns or drops required responses when a session is warm._
- **Execution-start boundary**: Persisted `run_started` marks the irreversible start of execution. Before `run_started`, a `dispatched` turn envelope may safely replay under the same `runId`; after `run_started`, an abrupt worker loss marks a turn `failed(worker_lost)` or `failed(lease_lost)` rather than replaying potentially side-effectful tool calls.
- **Prefix compaction cache**: Stores rebuildable `CompactionCache` summaries keyed by `(sessionId, coversThroughSeq)`. A degraded summary (produced after summarization failure or derived from a degraded excerpt) never overwrites a valid summary at the same boundary and is excluded from future cold-start snapshots, ensuring the next cold start re-reads raw events after the last clean prefix while recording an explicit `system_note` about truncated context.
- **Provider usage accounting**: Persists provider-reported `{ inputTokens, outputTokens, costUsd? }` on each `Run` and aggregates space totals alongside explicit report-coverage counts (`reportedRunCount` / `runCount`), never fabricating zero values when usage or cost is unreported.

### 1.4 Dispatcher & Load Balancer

- **Unified pipeline, distinct placement rules**:
  - **Main sessions** (`private`, `group-main`, console sessions) route strictly to `space.boundWorkerId`.
  - **Thread sessions** randomly select an online, enrolled worker satisfying `space.requiredTags` at creation and stay pinned permanently.
  - **Tickets** select any online, enrolled worker satisfying `space.requiredTags ∪ ticket.requiredTags` with `activeSlots < maxSlots`, ordered by lowest load ratio (`activeSlots / maxSlots`), advancing to the next candidate if atomic slot reservation fails.
- **Offline queuing & coalescing**: When a session's pinned worker is offline, `TxEnqueueTurn` persists the turn in `DispatchQueue` (stripping model API keys at rest and resolving fresh credentials at delivery). Consecutive never-dispatched `queued` turns for the same session coalesce atomically (`TxMergeQueue`) when flushed, crediting all authors in `Run.initiatorIds` and closing absorbed runs as `merged`.
- **Per-item fault isolation**: Periodic dispatch, receipt, and schedule sweeps isolate errors per session/ticket/schedule so a misconfigured model or deleted resource in one space never stalls other spaces.

### 1.5 Outbound Card Streamer & Reply Outbox

- **Full-snapshot projection**: Aggregates worker stream events per `runId` into monotonic, persisted `CardOutbox` projections throttled at ~500 ms, rendering `[collapsible thinking panel] + [tool status pills] + [markdown body] + [stop button (streaming only)]` and rolling over to a continuation card every `30,000` characters while preserving `runId` cancellation identity.
- **Silent machine turns & sanitized tool pills**: Machine turns (schedule wakeups, ticket receipts) open no card unless visible assistant text or thinking is produced, and stay silent on failure (logged only), whereas user-initiated turns that fail before output emit a concise failure notice. Tool pills display only the tool name and status (`running` / `completed` / `failed`), capped at the latest 10 tools — never arguments or outputs, which could leak credentials into group chats.
- **Crash-resilient reconciliation**: Before retrying an uncertain initial card reply after a crash, the streamer queries recent channel replies using deterministic reply UUIDs and `sendStartedAt` watermarks to avoid duplicate cards within the IM provider's query/dedup guarantees. Lease-expired runs converge to closed, non-streaming cards through a 2-second outbox recovery loop.

### 1.6 Scheduler

- Evaluates active `Schedule` entries (`at` one-shot and 5-field IANA-timezone `cron`) on a 1-second tick loop.
- Applies deterministic per-schedule jitter (`≤ min(10% of period, 15 minutes)`), coalesces missed recurring ticks into one delivery carrying `coalescedCount`, enforces a 7-day staleness cutoff on recurring `resume_session` schedules, and commits due fires atomically via `TxFire` (see [Triggers and Scheduling](../features/triggers-and-scheduling.md)).

### 1.7 Authentication, Authorization & Secret Protection

- **Authenticator port**: Extracts `UserIdentity` from request headers/tokens into request context; business logic never reads identity from payloads.
- **Role separation**: Space `owner` and `operator` roles govern space resources (`owner` exclusively controls space deletion, member removal, and ownership transfer). Global `admin` (bootstrapped via `MEEPO_ADMIN_USER_IDS`) manages only the global `Models` and `Channels` registries.
- **Cryptographic storage boundaries**:
  - Channel `appSecret`s and model `apiKey`s are encrypted at rest with AES-256-GCM using `MEEPO_SECRET_KEY` (mandatory in production).
  - Worker enrollment tokens and space webhook tokens are stored exclusively as SHA-256 hashes; plaintext values are returned once at issuance.
  - `DispatchQueue` rows store credential-free envelopes; model keys are resolved transiently on socket send.
  - Channel `appSecret`s and IM tenant access tokens never leave the server. `media.read` verifies enrollment scope, active session-worker affinity, and an exact persisted `ImageReference` in that session before downloading at most `10 MiB` via a cached, credential-fingerprinted tenant token (refreshed at 10% remaining lifetime capped at 60s, invalidated on HTTP 401).

## 2. Atomic Cross-Entity Transactions

Domain services compute state transitions, while persistence ports commit multi-entity mutations atomically so crashes or concurrent requests never leave orphaned runs, duplicate transcripts, or lost receipts.

### Transaction boundaries and cancellation contract

| Atomic Operation        | Invariant & Mutated Entities                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TxEnqueueTurn`         | Deduplicates `(channelId, messageId)` (when from IM/receipt), removes `InboundInbox` entry, appends input `CanonicalEvent`, creates `Run`, and inserts credential-free `DispatchQueue` item.                                                                                         |
| `TxMergeQueue`          | Coalesces consecutive `queued` (never-dispatched) session inputs into the earliest `Run` (`dispatched` with lease and combined `initiatorIds`), marking absorbed runs `merged` (`mergedIntoRunId`).                                                                                  |
| `TxClaimTicket`         | Verifies `ticket.status === 'pending'` and worker `activeSlots < maxSlots`; increments `attempt`, sets `claimed` + `assignedWorkerId`, reserves worker slot, and inserts `dispatched` `Run` with lease.                                                                              |
| `TxAppend`              | Validates worker ownership, active lease, and contiguous `clientSeq`; records `RunEvent` / `CanonicalEvent`, advances `Run` (`running` / `completed` / `failed`), settles `Ticket`, and enqueues receipt.                                                                            |
| `TxExpire`              | Fences lease-expired `Run` (`worker_lost` before start, `lease_lost` after start) and transitions matching ticket attempt to `pending` (resetting `pendingSince`), `manual_review`, or `failed` + receipt.                                                                           |
| `TxFire`                | Checks expected `lastFiredAt`, records `ScheduleFire`, advances `Schedule` cursor/status, and atomically creates either the `pending` `Ticket` or the queued session `Turn` (`Run` + event + queue).                                                                                 |
| `TxReset` (`/new`)      | Closes active `main` session, fences its non-terminal runs (`interrupted`), deletes its `DispatchQueue` and `resume_session` schedules, opens replacement session, dedups command, and queues reply.                                                                                 |
| `TxRebind`              | Interrupts running `main`-session runs, re-targets queued/dispatched `main` inputs and session bindings to the new worker, and appends migration `system_note`s. `thread` sessions remain untouched.                                                                                 |
| `TxClose` / `TxDelete`  | Closes session (or deletes space cascade), fences non-terminal runs, clears queued dispatches, and cancels bound `resume_session` schedules.                                                                                                                                         |
| **Ticket Cancellation** | Atomically transitions `pending \| claimed \| running \| manual_review` ticket to `cancelled` (checked against expected `status`/`attempt`), fences related non-terminal runs as `failed(cancelled)`, and enqueues a deduplicated origin receipt (`ticket:<id>:<attempt>:<status>`). |

**Post-commit abort delivery on cancellation**:
When cancelling a ticket (`POST /api/tickets/:id/cancel`), the database transaction commits **before** sending `run.abort` over WebSocket. Because associated runs are already persisted as `failed` with `terminalReason = 'cancelled'` once the transaction commits, the post-commit stop notifier selects runs on that ticket by `terminalReason === 'cancelled'` and sends `run.abort` to their assigned workers. Repeating a cancel request on an already-`cancelled` ticket returns the existing ticket unchanged (without rewriting `completedAt` or duplicating receipts) and re-emits `run.abort` so lost network frames are recoverable. Completed or failed tickets reject cancellation with `409`; if completion and cancellation race, optimistic `(status, attempt)` guards ensure the first committed state wins irrevocably.

## 3. Background Loops and Bounds

The control plane runs four periodic maintenance loops:

1. **Execution & Schedule Loop (`1s` interval, non-overlapping)**: Sweeps expired run leases and 24-hour unclaimed `pending` tickets (`ReliabilityService`), flushes pending `TicketReceipt`s into origin sessions, commits due `Schedule` fires, flushes connected session queues, and dispatches pending tickets.
2. **Channel & Outbox Recovery Loop (`2s` interval)**: Syncs active IM channel connections against `ChannelRegistry` changes, reconciles `CardOutbox` projections against terminal runs, retries pending card updates/replies, replays unfinished `InboundInbox` messages, and flushes `MessageOutbox` command replies.
3. **Worker Liveness Sweep (`workerOfflineAfterMs / 2`, default `22.5s`)**: Marks workers without a heartbeat inside `workerOfflineAfterMs` (`45s`) as `offline`.
4. **Retention Sweep (`1h` interval)**: Purges `ProcessedMessages` older than 7 days and `WebhookRequests` older than 30 days using indexed timestamp predicates.

Query bounds: incremental session event reads (`seq > afterSeq`) return at most **500** events per call; cold-start worker snapshots with compaction enabled page in **50**-event batches.

## 4. Current Implementation Notes

- **Single-replica assumptions**: In-process timers, SQLite write serialization, in-memory console stream grants (`30s` TTL), and per-space webhook rate counters (`60/min`) assume a single `meepo-server` instance.
- **Worker readiness barrier**: Workers execute `register → reconcile → event flush → worker.ready`, and wait locally for reconciliation before advancing model/tool steps; however, the server's 1-second dispatch sweep can currently dispatch to a newly registered connection slightly before `worker.ready` arrives. Workers absorb this safely via local readiness gating.
