# Worker Protocol

> **Scope**: Defines wire protocol version **3** over the `/ws/worker` WebSocket channel connecting `meepo-worker` (client) to `meepo-server` (server) — JSON-RPC framing, connection handshake and reconciliation, upstream RPC contracts, downstream server notifications, sequenced event durability, and payload bounds.

## 1. Framing and Error Envelope

Each worker maintains one outbound WebSocket connection to `/ws/worker` (`wss://` required across untrusted networks). Every message is a UTF-8 JSON object matching one of three envelopes:

- **Request**: `{ "kind": "request", "id": "<string>", "method": "<string>", "params": <object> }`
- **Response**: `{ "kind": "response", "id": "<string>", "result"?: <any>, "error"?: { "code": "<string>", "message": "<string>" } }`
- **Notification**: `{ "kind": "notification", "event": "<string>", "payload": <object> }`

Standard `error.code` values: `invalid_frame`, `unknown_method`, `invalid_params`, `unauthorized`, `not_found`, `internal`, plus domain-specific `MemoryError` codes (`invalid_path`, `invalid_prefix`, `revision_conflict`, `content_too_large`, `too_many_entries`) on `memory.call`. Unparseable frames return `id: "unknown"` with `invalid_frame`. Worker-side RPC calls enforce a `30s` response timeout, closing and reconnecting the socket on timeout or heartbeat failure.

## 2. Connection Handshake, Ownership, and Leases

```text
Worker                                              Server
  │── request: worker.register (protocolVersion=3) ──►│ validate version, token hash, 1:1 workerId binding
  │◄─ response: { workerId, spaceIds, intervalSec } ──│ attach socket (superseding any prior socket)
  │── request: run.reconcile (active, finished) ─────►│ fence missing running turns; return valid/invalid + seqs
  │◄─ response: { validRunIds, invalidRunIds, seqs } ─│
  │   (abort invalidRunIds; trim ACKed event buffers) │
  │── request: stream.append (replay unACKed events) ►│ idempotent commit by (runId, clientSeq)
  │── request: worker.ready {} ──────────────────────►│ flush queued session turns for workerId
  │── request: worker.heartbeat (every 15s) ─────────►│ renew leases (3 × interval = 45s) for listed activeRunIds
```

- **Protocol lockstep**: `worker.register` rejects any `protocolVersion !== 3`.
- **Token and socket fencing**: The server hashes `enrollmentToken` (SHA-256), rejects expired or revoked tokens on registration and on **every subsequent RPC**, and enforces permanent 1:1 binding between token and `workerId`. If a worker reconnects while an older socket is still open, the new registration atomically replaces the active socket in `WorkerConnectionHub`; frames from the superseded socket fail authorization immediately.
- **Run lease renewal**: Only non-terminal, unexpired runs owned by the caller and explicitly included in `worker.heartbeat.params.activeRunIds` have their `leaseExpiresAt` extended (`now + 3 × heartbeatIntervalSeconds`, server clock authoritative).

## 3. Upstream RPC Inventory (`Worker → Server`)

Every method after `worker.register` requires an authenticated active socket. No request may supply both `sessionId` and `ticketId` (`invalid_params`), ensuring lease validation and target lookup always resolve against the exact same resource.

| Method               | Parameters                                                                                                                                      | Response / Authorization Contract                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `worker.register`    | `protocolVersion`, `workerId`, `enrollmentToken`, `hostname`, `os` (`darwin\|linux\|win32`), `arch`, `tags[]`, `capacity:{maxSlots}`, `version` | `{ workerId, spaceIds[], heartbeatIntervalSeconds }`. Binds unbound spaces on first registration.                                |
| `run.reconcile`      | `activeRunIds[]`, `recentlyFinishedRunIds[]`                                                                                                    | `{ validRunIds[], invalidRunIds[], lastConfirmedClientSeq: {[runId]: number} }`. Marks unreported `running` turns `worker_lost`. |
| `worker.ready`       | `{}`                                                                                                                                            | `{ accepted: true }`; triggers server queue flush for `workerId`.                                                                |
| `worker.heartbeat`   | `workerId`, `timestamp`, `capacity:{maxSlots, activeSlots, cpuUsage?, memoryUsage?}`, `activeRunIds[]`                                          | `{ accepted: true }`; updates worker capacity/status and renews listed run leases.                                               |
| `stream.append`      | `WorkerStreamEvent & { clientSeq: number }`                                                                                                     | `{ accepted: boolean, lastConfirmedClientSeq: number, duplicate?: boolean, reason?: string }` after durable commit.              |
| `session.snapshot`   | `sessionId`, `beforeSeq?`, `beforeTimestamp?`, `useCompaction?: boolean`, `afterSeq?: number`                                                   | `SessionSnapshot { sessionId, version, messages[], events?, compaction?, hasMore? }`. Requires space scope + session affinity.   |
| `session.compaction` | `sessionId`, `runId`, `summary` (`≤ 32 KiB`), `coversThroughSeq`, `degraded?: boolean`                                                          | `{ recorded: true }`. Requires live `dispatched\|running` turn lease on `sessionId`; degraded never overwrites clean cache.      |
| `prompt.prepare`     | `{ sessionId }` _or_ `{ ticketId }`                                                                                                             | `{ base: string, memoryMap: string, memoryMapVersion: number }`. Freezes `prompt_identity` on first session call.                |
| `prompt.record`      | `sessionId`, `snapshot` (serialized JSON `≤ 256 KB`)                                                                                            | `{ recorded: true }`. Appends `prompt_snapshot` to canonical session events.                                                     |
| `media.read`         | `sessionId`, `messageId`, `fileKey`                                                                                                             | `{ data: <base64>, mimeType, sizeBytes }`. Requires session affinity + exact persisted `ImageReference`; `≤ 10 MiB`.             |
| `memory.call`        | `runId`, `sessionId` _or_ `ticketId`, `operation` (`list\|search\|read\|write\|delete\|map`), `input`                                           | Memory operation result. Requires unexpired `running` lease matching the session or assigned ticket.                             |
| `cron.create`        | `runId`, `sessionId`, `prompt`, `timing`                                                                                                        | `ScheduleView`. Requires unexpired `running` turn lease on `sessionId`.                                                          |
| `cron.list`          | `sessionId`                                                                                                                                     | Active `ScheduleView[]` for `sessionId`. Requires session affinity.                                                              |
| `cron.delete`        | `runId`, `sessionId`, `scheduleId`                                                                                                              | `{ deleted: true }`. Requires unexpired `running` turn lease; schedule must belong to `sessionId`.                               |
| `ticket.create`      | `runId`, `sessionId`, `objective`, `contextSummary?`, `requiredTags?`, `timing?`                                                                | `{ kind: 'ticket', ticket }` (immediate) or `{ kind: 'schedule', schedule }` (timed). Requires `running` turn lease.             |

Legacy fire-and-forget upstream `stream` notifications are rejected with a warning; all worker stream events must use `stream.append`.

## 4. Downstream Notifications (`Server → Worker`)

The worker deduplicates incoming `turn.dispatch` and `ticket.dispatch` notifications by `runId` across reconnects before queuing execution.

| Event             | Payload                                                                                                                                                                                                                                                                                                         | Semantics                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `turn.dispatch`   | `runId`, `sessionId`, `spaceId`, `sessionKind`, `turnRef?: {sessionId, sourceId}`, `mergedSourceIds?`, `prompt`, `source`, `delivery` (`urgent\|wait\|if_idle`), `model`, `currentTime?`, `snapshotBeforeSeq?`, `snapshotBefore?`, `systemPromptContribution?`, `images?`, `mediaNamespace?`, `timeoutSeconds?` | Executable session turn. `model` carries `{ provider, baseUrl, apiKey, model, thinkingLevel?, imageInput? }`.           |
| `ticket.dispatch` | `runId`, `ticketId`, `attempt?`, `spaceId`, `objective`, `contextSummary?`, `source`, `model`, `currentTime?`, `systemPromptContribution?`, `timeoutSeconds?`                                                                                                                                                   | Executable independent ticket attempt in fresh `<ticketsDir>/<ticketId>/attempt-N`.                                     |
| `context.append`  | `sessionId`, `events: CanonicalEvent[]`                                                                                                                                                                                                                                                                         | Passive history-only notes (e.g., migration `system_note`) appended to warm runner state between turns; never executes. |
| `run.abort`       | `runId`, `reason?`                                                                                                                                                                                                                                                                                              | Cancels queued waiter or aborts in-flight model/tool execution for `runId`.                                             |
| `session.closed`  | `sessionId`                                                                                                                                                                                                                                                                                                     | Aborts session work, releases MCP leases, and deletes local session directory (`thread` sessions unaffected by rebind). |
| `run.steer`       | `runId`, `message`                                                                                                                                                                                                                                                                                              | Injects steering message into an active agent loop (legacy hook; reserved `urgent` delivery aborts and starts new run). |

`DispatchSource` is one of `{ kind: 'user_message', messageId }`, `{ kind: 'schedule', scheduleId, coalescedCount, stale }`, `{ kind: 'webhook', event }`, or `{ kind: 'system' }`.

## 5. Sequenced Events, Checkpoints, and Payload Limits

### `WorkerStreamEvent` Variants (`clientSeq = 1..N` per `runId`)

- Lifecycle: `run_started { runId, workerId, sessionId?, ticketId? }`, `run_completed { runId, resultSummary?, usage?: { inputTokens, outputTokens } }`, `run_failed { runId, error, code? }`, `run_merged { runId, mergedIntoRunId }`, `run_dropped { runId }`.
- Streaming (transport-only, not stored in `CanonicalEvent` or `RunEvent`): `text_delta { runId, delta }`, `thinking_delta { runId, delta }`, `tool_execution_update { runId, toolCallId, partialResult }`.
- Canonical content & tools: `assistant_text { runId, content }`, `tool_execution_start { runId, toolName, toolCallId, args }` (stored as `tool_call`), `tool_execution_end { runId, toolCallId, result, isError }` (stored as `tool_result`), `context_note { runId, content }` (stored as `system_note`).

### Ordering, Fencing, and Execution Checkpoints

1. **Contiguous per-run ordering**: `clientSeq` starts at `1` and increments by `1` per event on a `runId`. Duplicate `(runId, clientSeq) <= lastClientSeq` returns `{ accepted: true, duplicate: true, lastConfirmedClientSeq }`. Sequence gaps (`reason: 'sequence_gap'`), wrong worker ownership, expired leases, or events arriving after a terminal state return `{ accepted: false, reason }`; on any rejection other than `sequence_gap`, the worker marks `runId` invalid and aborts local execution immediately.
2. **Pre-step flush barrier**: The worker awaits `stream.append` ACKs on every non-delta boundary (`tool_execution_start`, `tool_execution_end`, `message_end`) before beginning the next tool or model request. Consequently, a `tool_call` is durably recorded on the server before its local side effect executes, ensuring crash recovery never loses visibility that a tool was invoked.
3. **Payload bounds & idempotency metadata**: Tool `args`, `partialResult`, and `result` payloads are bounded to **`64 KiB`** UTF-8 at both worker emission and server journal ingestion (`{ truncated: true, originalBytes, preview }`). Ticket runs propagate `<ticketId>-<attempt>` via `MEEPO_IDEMPOTENCY_KEY` to `bash` child processes and `_meta.meepoIdempotencyKey` to MCP `callTool` requests; external tools must opt in to honor that key.
