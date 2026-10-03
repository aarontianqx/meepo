# Worker Protocol

Protocol version **3** uses one outbound WebSocket per worker at `/ws/worker`. Shared TypeScript contracts live in `packages/protocol`. Frames are JSON: request `{kind:"request",id,method,params}`, response `{kind:"response",id,result? ,error?}`, notification `{kind:"notification",event,payload}`. Errors contain `code` and `message`.

## Connection and ownership

Registration rejects protocol mismatches. The server hashes the enrollment token, binds it to the worker ID on first use and rejects both a token used with another ID and another token claiming an existing ID. The worker ID persists in its data directory. Token authorization is rechecked on RPC calls; membership of a worker's served spaces derives exclusively from its enrollment.

The worker performs registration, reconciliation, buffered-event replay and `worker.ready`. The ready handler requests a queue flush, but the current server also dispatches through its periodic sweep based on connection/online status; it does not yet enforce a global pre-ready dispatch barrier. Worker execution checks wait for local reconciliation readiness and event ACKs before model/tool progression. Consolidating the server-side readiness gate remains pending. A replaced connection cannot impersonate the current connection. Heartbeats list all owned active/queued runs; only those listed renew their lease, for three heartbeat intervals (45 seconds by default, measured by the server). Expired or terminal runs cannot renew.

On disconnection, the worker waits before its next model/tool call and buffers stream events. An already executing tool may finish locally. After the lease window it aborts local work; on reconnect it also aborts every invalidated run. Unknown-outcome tools remain unknown in reconstructed history, with a matching synthetic error result; they are never automatically repeated as part of recovery.

## Worker → server RPC inventory

| Method             | Parameters                                                                                                           | Result / checks                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `worker.register`  | `protocolVersion`, `workerId`, `enrollmentToken`, `hostname`, `os`, `arch`, `tags[]`, `capacity.maxSlots`, `version` | `{workerId,spaceIds[],heartbeatIntervalSeconds}`                                            |
| `worker.heartbeat` | `workerId`, `timestamp`, `capacity:{maxSlots,activeSlots,cpuUsage?,memoryUsage?}`, `activeRunIds[]`                  | `{accepted:true}`; renews only listed valid runs                                            |
| `run.reconcile`    | `activeRunIds[]`, `recentlyFinishedRunIds[]`                                                                         | `{validRunIds[],invalidRunIds[],lastConfirmedClientSeq:{[runId]:seq}}`                      |
| `worker.ready`     | `{}`                                                                                                                 | `{accepted:true}`; queued delivery follows reconciliation                                   |
| `stream.append`    | Worker event plus `runId`, `clientSeq`                                                                               | `{accepted,lastConfirmedClientSeq,duplicate?,reason?}` after commit                         |
| `session.snapshot` | `sessionId`, `beforeSeq?`, legacy `beforeTimestamp?`                                                                 | `{sessionId,version,messages[],events[]}`; requires worker affinity and space scope         |
| `prompt.prepare`   | `sessionId` or `ticketId`                                                                                            | `{base,memoryMap,memoryMapVersion}`; session identity/preset stays frozen                   |
| `prompt.record`    | `sessionId`, `snapshot`                                                                                              | `{recorded:true}`; persists the worker-rendered snapshot                                    |
| `memory.call`      | `runId`, `sessionId` or `ticketId`, `operation`, `input`                                                             | Memory contract result; operations `list/search/read/write/delete/map`                      |
| `cron.create`      | `runId`, `sessionId`, `prompt`, `timing`                                                                             | `ScheduleView`; creates a resume-session schedule                                           |
| `cron.list`        | `sessionId`                                                                                                          | Active `ScheduleView[]` for that session                                                    |
| `cron.delete`      | `runId`, `sessionId`, `scheduleId`                                                                                   | `{deleted:true}`; schedule must belong to the session                                       |
| `ticket.create`    | `runId`, `sessionId`, `objective`, `contextSummary?`, `requiredTags?`, `timing?`                                     | `{kind:"ticket",ticket:{id,objective,status}}` or `{kind:"schedule",schedule:ScheduleView}` |

Additional RPC contracts:

- `media.read {sessionId,messageId,fileKey}` → `{data:<base64>,mimeType,sizeBytes}`. Requires enrollment scope, active session affinity and an exact image reference already persisted in that session. Arbitrary URLs/messages/files are not accepted. Actual download size is limited to 10 MiB on server and worker.
- `session.snapshot` additionally accepts `useCompaction:true, afterSeq?`; returns `compaction?:{summary,coversThroughSeq}`, at most 50 events and `hasMore`. Advance using the final returned event sequence; `version` remains the overall log version. Legacy/full Console snapshot reads do not use the summary cache.
- `session.compaction {sessionId,runId,summary,coversThroughSeq,degraded?}` requires a live dispatched/running run and session ownership; summary ≤32 KiB and coverage within the stored event range. Recording the same prefix is idempotent. Cache data never replaces original events.

Memory calls and schedule/ticket mutations require an unexpired running `runId` owned by the caller and matching the session/ticket. Resource identifiers never grant access by themselves. Timing is `{kind:"at",at:<epoch-ms>}` or `{kind:"cron",expression,timezone?}`. The old unacknowledged upstream `stream` notification is rejected; event persistence uses `stream.append`.

## Server → worker notifications

| Event             | Payload                                                                                                                                                                                                                           | Semantics                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `turn.dispatch`   | `runId`, `sessionId`, `spaceId`, `sessionKind`, `turnRef:{sessionId,sourceId}`, `prompt`, `source`, `delivery`, `model`, `currentTime`, `snapshotBeforeSeq?`, `mergedSourceIds?`, `images?`, `mediaNamespace?`, `timeoutSeconds?` | Executable input; delivery is `urgent/wait/if_idle`. Stored queue envelopes exclude credentials; they resolve at delivery. |
| `ticket.dispatch` | `runId`, `ticketId`, `attempt`, `spaceId`, `objective`, `contextSummary?`, `source`, `model`, `currentTime`, `timeoutSeconds?`                                                                                                    | Fresh attempt and directory; tools receive `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>`.                                   |
| `context.append`  | `sessionId`, `events[]`                                                                                                                                                                                                           | History-only notes, applied between turns. Executable input never uses this channel.                                       |
| `run.abort`       | `runId`, `reason?`                                                                                                                                                                                                                | Abort active tool/model or remove queued execution.                                                                        |
| `session.closed`  | `sessionId`                                                                                                                                                                                                                       | Close/rebind detaches local resources; main-session rebind preserves transcript and does not detach thread sessions.       |
| `run.steer`       | `runId`, `message`                                                                                                                                                                                                                | Legacy explicit steering hook; reserved urgent delivery uses abort plus a new run instead.                                 |

`model` carries `{provider,baseUrl,apiKey,model,thinkingLevel?,imageInput?}`. Image references carry `{messageId,fileKey,mimeType?,sizeBytes?}`; the namespace is a non-secret cache key. `media.read` returns authorized image bytes as base64 plus MIME/size; channel credentials and tenant tokens remain on the server. Source discriminates `user_message`, `schedule`, `webhook` or `system`.

## Events and durability

Each event has a strictly increasing per-run `clientSeq`, starting at 1. Event types are `run_started`, `text_delta`, `thinking_delta`, `tool_execution_start/update/end`, `assistant_text`, `run_completed`, `run_failed`, `run_merged`, `run_dropped`, `context_note`. The last maps to a durable `system_note` explaining context truncation. Completion can include model usage and a result summary; failure includes error/code; merge references the surviving run.

The journal maps tool start/end to canonical `tool_call/tool_result` with preserved `toolCallId`. Deltas are acknowledged but not persisted in the canonical event stream. Session events add their own monotonically increasing `seq`; ticket execution detail remains in the run stream and only a receipt reaches the origin session. Usage is persisted on the run.

An ACK confirms the atomic commit of event, transcript and run/ticket projection. Duplicate `(runId,clientSeq)` returns the existing ACK, including lost terminal ACKs. Gaps, expired leases, wrong worker ownership and new events on terminal runs are rejected. A worker flushes tool-call ACKs before executing tools, and tool-result ACKs before progressing to another model/tool call. Unacknowledged buffered events replay on reconnect.

Before a committed `run_started`, delivery may replay under the same run ID. Afterwards a worker process restart does not blindly repeat that turn: the server marks a missing running turn `worker_lost`; ticket lease recovery applies its explicit safe-retry/manual-review policy. Exactly-once event recording does not claim exactly-once external side effects; uncertain side effects require manual review or explicitly idempotent work.

Tool argument/result payloads are bounded to 64 KiB at worker forwarding and durable server ingestion; oversize values become an explicit preview with original byte count. Normal structured results remain intact. Worker tools preserve full oversize results in a local task artifact before returning a bounded preview to the agent. This includes MCP; built-in bash already has its own 2000-line/50 KiB limit.

Ticket idempotency context reaches bash subprocesses as `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>` and MCP calls as `_meta.meepoIdempotencyKey`. MCP servers must explicitly honor that metadata; it is not an environment variable injected into a shared MCP process or a guarantee of external exactly-once effects.
