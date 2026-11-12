# Feature: Asynchronous Ticket Pipeline

> **Scope**: Defines **Tickets** — independent, self-contained background tasks — including their state machine, attempt isolation, conservative retry eligibility, idempotency propagation, cancellation fencing, creation entry points, and origin-session receipts.

## 1. Purpose and Isolation Model

Interactive sessions optimize for stateful human dialogue pinned to one machine. Long-running, deferred, scheduled, or webhook-triggered jobs (audits, multi-step investigations, CI/alert triage, batch refactorings) are modeled as **Tickets**:

```text
Agent tool / Console / HTTP / Webhook / Schedule
        │
        ▼
  pending Ticket ──claimed──► Attempt N (Run in fresh <ticketsDir>/<id>/attempt-N) ──► Outcome + Origin Receipt
```

- **No session affinity**: Any online, enrolled worker matching `space.requiredTags ∪ ticket.requiredTags` with a free slot may claim a pending ticket, preferring the lowest `activeSlots / maxSlots` ratio.
- **Clean context**: Tickets never inherit raw conversational chat logs; they receive only `{ title, objective, contextSummary? }` plus space memory tools (`MemoryList`/`Search`/`Read`/`Write`/`Delete`) and workspace/MCP tools. Orchestration tools (`Cron*`, `TicketCreate`) are withheld so tickets cannot spawn unbounded background work.
- **Fresh workspace per attempt**: Every dispatch increments `attempt` (`1..3`) and creates a brand-new `<ticketsDir>/<ticketId>/attempt-<attempt>` directory; prior attempt directories remain untouched until the 7-day directory sweep reclaims them.

## 2. Ticket State Machine

| Current State                                       | Trigger / Condition                                       | Next State      | `terminalReason` / Side Effects                                      |
| --------------------------------------------------- | --------------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `pending`                                           | Claimed by an eligible worker (`TxClaimTicket`)           | `claimed`       | `attempt += 1`, `assignedWorkerId` set, `dispatched` `Run` created   |
| `pending`                                           | Unclaimed for `24h` (`now - pendingSince >= 86,400,000`)  | `failed`        | `unclaimed`; enqueues origin receipt                                 |
| `claimed`                                           | Worker emits `run_started` (`TxAppend`)                   | `running`       | `Run` transitions to `running`                                       |
| `claimed`                                           | Lease expires before `run_started`, `attempt < 3`         | `pending`       | `Run` marked `failed(worker_lost)`; `pendingSince` reset; no receipt |
| `running`                                           | Agent finishes normally (`run_completed`)                 | `completed`     | `result.summary` stored; enqueues origin receipt                     |
| `running`                                           | Agent/model errors (`run_failed`)                         | `failed`        | `error` (summary stores error message); enqueues origin receipt      |
| `running`                                           | Lease expires, retry-eligible, `attempt < 3`              | `pending`       | `Run` marked `failed(lease_lost)`; `pendingSince` reset; no receipt  |
| `running`                                           | Lease expires, **not** retry-eligible, `attempt < 3`      | `manual_review` | `Run` marked `failed(lease_lost)`; enqueues origin receipt           |
| `claimed` / `running`                               | Lease expires with `attempt >= 3`                         | `failed`        | `max_attempts`; enqueues origin receipt                              |
| `manual_review`                                     | Operator retries (`POST /api/tickets/:id/requeue`, `< 3`) | `pending`       | `assignedWorkerId` cleared, `pendingSince` reset to `now`            |
| `manual_review`                                     | Operator abandons (`POST /api/tickets/:id/abandon`)       | `failed`        | `abandoned`; enqueues origin receipt                                 |
| `pending` / `claimed` / `running` / `manual_review` | Operator cancels (`POST /api/tickets/:id/cancel`)         | `cancelled`     | `cancelled`; fences runs, sends `run.abort`, enqueues origin receipt |

`completed`, `failed`, and `cancelled` are terminal (`completed` means the agent finished execution and produced `result.summary`, not human sign-off).

## 3. Conservative Retry Policy and Idempotency

### Attempt Retry Eligibility (`maxAttempts = 3`)

When a worker's execution lease expires mid-attempt (`TxExpire`), Meepo never blindly replays potentially side-effectful operations:

1. **Never started (`run.startedAt === undefined`)**: Safe to auto-retry (`pending`).
2. **Explicitly idempotent (`ticket.idempotent === true`)**: Safe to auto-retry (`pending`).
3. **Proven read-only tool trace**: Safe to auto-retry if every persisted `tool_call` event in that run's `RunEvent` journal belongs to the local read-only allowlist (`read`, `grep`, `ls`, `glob`). Any invocation of `bash`, `write`, `edit`, memory tools, or MCP tools is treated as potentially side-effectful.
4. **Otherwise**: If `attempt < 3`, the ticket parks in **`manual_review`** so a human operator can inspect the recorded attempt trace in the Console and choose either **Retry** (`requeue`) or **Abandon**. If `attempt >= 3`, the ticket terminates as `failed(max_attempts)`.

### `pendingSince` Expiration Clock

Each ticket tracks `pendingSince`, initialized at creation and reset **only** when transitioning back into `pending` (via automatic retry or manual `requeue`). Unrelated metadata updates do not extend the 24-hour `unclaimed` deadline, and time spent executing a prior attempt does not eat into a retried ticket's pending window.

### Downstream Idempotency Key Propagation

During attempt `N`, the worker injects `<ticketId>-<N>` into:

- The user prompt (`Tool environment: MEEPO_IDEMPOTENCY_KEY=<ticketId>-<N>...`).
- `bash` subprocess environment variables (`MEEPO_IDEMPOTENCY_KEY`).
- MCP `callTool` request metadata (`_meta.meepoIdempotencyKey`).

_Rationale: Distinguishes per-attempt execution keys (`<ticketId>-<attempt>`) from webhook ingestion keys (`Idempotency-Key`), allowing cooperating external scripts and MCP servers to deduplicate retries safely._

## 4. Cancellation, Observability, and Origin Receipts

- **Cancellation (`POST /api/tickets/:id/cancel`)**: Commits ticket `cancelled`, fences active runs as `failed(cancelled)`, and enqueues the origin receipt in one transaction before sending `run.abort` to assigned workers. Repeating cancel on an already-`cancelled` ticket is idempotent (returning the unchanged ticket and re-sending `run.abort`); cancelling a `completed` or `failed` ticket returns `409`. Session card `Stop` buttons in IM do **not** cancel independent tickets. Cancellation stops active subprocesses and prevents retries, but does not roll back external effects already performed.
- **Per-attempt execution trace**: Non-delta events (`run_started`, `tool_call`, `tool_result`, `assistant_text`, `context_note`, terminal events) are persisted in `RunEvent` per `runId` and inspectable per attempt via `GET /api/tickets/:id/runs`.
- **Origin session receipts**: When `originSessionId` is set, terminal transitions (`completed`, `failed`, `cancelled`) and `manual_review` transitions enqueue a deduplicated `TicketReceipt` (automatic retries back to `pending` stay silent so transient worker blips do not spam chat). `ReceiptService` delivers the summary receipt:
  - If the origin session is **open** (`active` or `idle`): dispatches a `system_note` turn with `delivery: 'wait'` (waking the session agent to report or act on the outcome; queued behind active work if busy).
  - If the origin session is **`closed`**: records a transcript-only note (`TxDeliverClosed`) without waking a runner or posting to IM.

## 5. Creation Entry Points and Controls

| Entry Point                                     | Authentication                 | `originSessionId`        | `idempotent` Flag                                             |
| ----------------------------------------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------- |
| Direct API (`POST /api/tickets`)                | Space member                   | Optional (same space)    | Supported (`boolean`, defaults to `false`)                    |
| Webhook (`POST /api/webhooks/:spaceId/tickets`) | Space Bearer secret or member  | Forbidden (always unset) | Supported (`boolean`); separate from `Idempotency-Key` header |
| Console ticket form                             | Space member                   | Unset                    | Omitted by design (uses conservative trace-based retry)       |
| Agent `TicketCreate` tool                       | Active session `running` lease | Bound to calling session | Omitted by design (never inferred from natural language)      |
| `Schedule` (`action.kind = 'create_ticket'`)    | Stored schedule creator        | Preserved from schedule  | Omitted by design (`false`)                                   |

Webhook `Idempotency-Key` headers deduplicate **HTTP ticket creation requests** for 30 days (`409` on payload hash mismatch); they do not mark the created `Ticket` itself as `idempotent: true`.
