# Worker Protocol

The wire contract between `meepo-server` and `meepo-worker`: one persistent outbound WebSocket per worker, JSON frames. This document defines the reliability semantics; the exhaustive field-level RPC inventory lives in `packages/protocol/` and is completed in W0.

## 1. Connection Lifecycle

- **`register`**: `{ workerId, token, protocolVersion, tags, maxSlots }`. The server validates the token (SHA-256 match), **binds the token to the presented `workerId` on first use** (later mismatches are rejected), and rejects a `protocolVersion` mismatch with an explicit error — this is a guard, not negotiation.
- **`workerId`**: generated at first boot, persisted in the worker's data directory, stable across restarts.
- **Heartbeats**: every 15s (interval advertised by the server at registration), carrying `activeRunIds`, slot utilization, and CPU/memory stats. Each heartbeat **renews the execution lease** of the runs it carries in `activeRunIds` (lease = 3 intervals, 45s at the default, server clock authoritative).
- **Connection loss**: the worker starts no new runs and suspends active ones past the lease window (no new model/tool calls; processes stay alive).
- **Reconnect**: the worker sends `run.reconcile { activeRunIds, recentlyFinishedRunIds }`. The server fails runs it has no record of (`failed(worker_lost)`), replies which of the worker's active runs are still valid — **invalidated runs must be killed locally** — and flushes queued dispatches.

## 2. Channels (server → worker)

| Envelope | Carries | Notes |
| --- | --- | --- |
| `turn.dispatch` | Executable work for a session: user turns, schedule fires, console injections, ticket receipts | Delivery semantics: `urgent` / `wait` / `if_idle` |
| `ticket.dispatch` | A ticket attempt: objective bundle, injected credentials (model, channel), `MEEPO_IDEMPOTENCY_KEY` | Credentials resolve from server-side references at delivery |
| `context.append` | History-only writes that need no response (e.g. the post-rebind migration `system_note`) | Applied between turns, never mid-turn |
| `abort` | Cancel a run: stop button, rebind, `/new`, `urgent` | Running tool child processes are cancelled |
| `session.closed` | The session was closed (`/new`, space rebind of thread sessions) | Worker reclaims the session's local resources |

## 3. Events (worker → server)

- Every event carries **`(runId, clientSeq)`** — a per-run monotonic sequence starting at 1.
- The server **dedups on `(runId, clientSeq)`** and ACKs only after persistence. The worker buffers unacknowledged events; on reconnect the server hands back `lastConfirmedClientSeq` and the worker replays the buffer — every event lands exactly once.
- Terminal events (`run_completed` / `run_failed`) are retried until ACKed.
- Event types: `run_started`, `text_delta`, `thinking_delta`, `tool_execution_start` / `_update` / `_end`, `assistant_text`, `tool_call`, `tool_result`, `run_completed`, `run_failed`, `usage`.

## 4. Reliability Invariants

1. At most one worker owns a ticket attempt at any time (lease + reconcile fencing).
2. Late results from expired attempts are rejected (logged only).
3. A dispatch is durable once its `run_started` event is persisted; everything before that point is re-dispatchable.
4. `protocolVersion` is a single integer, bumped on every breaking change; the server rejects mismatches at `register`.
