# Feature: Triggers and Scheduling

> **Scope**: Defines Meepo's unified execution domain (`Schedule → Ticket | Turn → Run`), `at` and `cron` timing rules, jitter/coalescing/staleness bounds, atomic fire commitment, `Run` state transitions, and the context-continuity boundary governing agent scheduling tools.

## 1. The Unified Execution Model

Meepo models all deferred, recurring, interactive, and asynchronous work with five orthogonal nouns:

```text
Schedule (when) ──fires──► Ticket (independent work) | Turn (in-session work) ──executed as──► Run (attempt)
```

| Entity       | Question Answered              | Responsibility                                                                                              |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Schedule** | _When_ is work produced?       | Durable server timer pairing `timing` (`at` or `cron`) with `action` (`create_ticket` or `resume_session`). |
| **Ticket**   | _What_ independent work?       | Self-contained objective executed in a fresh workspace on any eligible worker; retryable up to 3 attempts.  |
| **Turn**     | _What_ in-session work?        | One continuation (`turnRef = {sessionId, sourceId}`) of an existing Session on its pinned worker.           |
| **Session**  | _In which_ persistent context? | Window-bound conversation container (`main` or `thread`) owning the canonical event transcript.             |
| **Run**      | _Who_ ran it, to _what_ end?   | Single execution attempt of a Ticket or Turn, owning lease, sequenced events, usage, and settlement.        |

_Rationale: Unifying reminders, cron wakeups, interactive chat turns, and async tickets under `Schedule → Ticket | Turn → Run` eliminates parallel job schedulers and ensures lease fencing, usage accounting, and event deduplication work identically across every trigger._

## 2. Schedule Semantics and Timing Rules

### Timing Variants

- **One-shot (`{ kind: 'at', at: <epoch-ms> }`)**: Fires once as soon as `now >= at`, transitions `status` from `'active'` to `'done'`, and sets `lastFiredAt = now`. If the server was offline at `at`, it catches up **once** on the next scheduler tick (`coalescedCount = 1`). Jitter does not apply to `at`.
- **Recurring (`{ kind: 'cron', expression: '<5-field>', timezone?: '<IANA>' }`)**: Strictly 5-field cron expression (`minute hour day-of-month month day-of-week`) evaluated in `timing.timezone` (defaulting to `space.timezone`, then `'UTC'`), with daylight-saving transitions handled according to IANA rules. Stored timestamps remain UTC.

### Action Variants and Staleness Cutoff

- **`create_ticket`**: Materializes a fresh `pending` `Ticket` (`title` derived from the first 80 chars of `objective`, inheriting `requiredTags ?? space.requiredTags` and optional `originSessionId`). Runs indefinitely until cancelled (`deleted`).
- **`resume_session`**: Enqueues a `wait` `Turn` (`<schedule-fire ...>`) into `sessionId`.
  - **7-day staleness guard**: When a recurring `resume_session` schedule fires more than **7 days** after `createdAt` (`now - createdAt > 7 × 86,400,000`), that delivery fires one final time with `stale="true"` and atomically transitions the schedule to `'done'`. If continued automation is still desired, the woken agent must explicitly call `CronCreate` to register a new 7-day schedule.
  - **Session lifecycle coupling**: Closing a session or running `/new` cascade-deletes (`status = 'deleted'`) all `resume_session` schedules targeting that session (and any fire encountering an already-closed session deletes the schedule without dispatching). `create_ticket` schedules are unaffected by `/new`, even when carrying `originSessionId`.
  - **Per-session cap**: At most **50** active `resume_session` schedules may exist per session, bounding recursive `CronCreate` calls from machine turns.

### Jitter, Coalescing, and Atomic Fires

- **Deterministic jitter**: Every `cron` schedule adds a deterministic offset derived from `hash(scheduleId) % floor(min(0.1 × periodMs, 15 minutes))` to its ideal fire instants, spreading synchronized schedules (such as `0 9 * * *`) across workers without losing predictability.
- **Missed-fire coalescing**: All jittered fire instants falling in `(lastFiredAt ?? createdAt, now]` collapse into a **single** fire carrying `coalescedCount` (bounded at `10,000` iterations).
- **Atomic commitment (`TxFire`)**: Advancing `Schedule.lastFiredAt`/`status`, recording `ScheduleFire`, and inserting the resulting `Ticket` or queued `Turn` commit in one database transaction. When the target session is busy or its bound worker is offline, the `Turn` queues durably (`wait`) rather than dropping or interrupting mid-turn.
- **Agent-created one-shots must lie in the future**: `CronCreate` and scheduled `TicketCreate` reject an `at` that is not after the server clock, and the error states the current server time (ISO and epoch ms) so the model can retry. Console/HTTP creation keeps the catch-up semantics above.
  _Rationale: models cannot see the clock and compute epoch milliseconds badly; a silently accepted past time fires at once and looks like success._
- **Attribution**: Schedules created via Console HTTP record the caller's `userId` as `createdByUserId`; schedules created by agent tools record `Run.initiatorIds[0]` (or `'agent'` when created during a machine turn).

## 3. Run State Machine

Every dispatch of a Turn or Ticket creates a `Run`:

| From                                | Event / Transition                                       | To           | `terminalReason` & Notes                                                                        |
| ----------------------------------- | -------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `queued`                            | Sent to online worker (`turn.dispatch` / `TxMergeQueue`) | `dispatched` | `leaseExpiresAt` armed (`now + 45s`)                                                            |
| `queued`                            | Absorbed into earlier queued turn before/during flush    | `merged`     | `mergedIntoRunId` points to surviving `Run`                                                     |
| `queued`                            | `if_idle` turn arrives while session is busy             | `dropped`    | Reserved delivery mode                                                                          |
| `dispatched`                        | Worker emits `run_started` (`TxAppend`)                  | `running`    | `startedAt` set                                                                                 |
| `dispatched`                        | Lease expires or reconcile misses turn before start      | `failed`     | `worker_lost` (tickets may spawn a new `Run` on next attempt)                                   |
| `running`                           | Worker emits `run_completed`                             | `completed`  | `usage` and `resultSummary` persisted                                                           |
| `running`                           | Worker emits `run_failed` (model/tool error, timeout)    | `failed`     | `error`, `timeout`, `aborted`, or `interrupted`                                                 |
| `running`                           | Heartbeat lease expires (`TxExpire`)                     | `failed`     | `lease_lost`                                                                                    |
| `queued` / `dispatched` / `running` | Session Stop, `/new`, session close, or `main` rebind    | `failed`     | `interrupted` (`TxRebind` migrates never-started queued/dispatched `main` inputs to new worker) |
| `queued` / `dispatched` / `running` | Ticket cancelled (`POST /api/tickets/:id/cancel`)        | `failed`     | `cancelled`                                                                                     |

`completed`, `failed`, `merged`, and `dropped` are terminal; late events on terminal runs are rejected.

## 4. Agent Orchestration Tools and Selection Criterion

Interactive sessions expose four server-backed orchestration tools (withheld from tickets):

- **`CronCreate` / `CronList` / `CronDelete`**: Manage `resume_session` schedules for the **current session** ("wake _this_ conversation later with full transcript and local session directory intact").
- **`TicketCreate`**: Creates an independent `Ticket` immediately (when `timing` is omitted) or registers a `create_ticket` `Schedule` (when `timing` is provided), linking `originSessionId` back to the calling session for completion receipts.

**Decision boundary — Context Continuity, Not Timing**:
Whether work runs now or on a schedule does _not_ choose the tool; **context dependency** does. If an agent that has never seen the current conversation can execute the task from a self-contained `objective` + `contextSummary` (such as daily health checks, standalone PR tasks, or batch audits), `TicketCreate` is appropriate. If the followup relies on ongoing dialogue history, conversational pronouns, or uncommitted files inside `<sessionsDir>/<sessionId>`, `CronCreate` (`resume_session`) is required.
