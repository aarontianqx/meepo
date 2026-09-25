# Feature: Triggers & Scheduling

## 1. Two Primitives

MEEPO distinguishes two scheduling primitives, which must never be conflated:

|                 | **Reminder** (task-level)              | **Cron** (session-level)                           |
| --------------- | -------------------------------------- | -------------------------------------------------- |
| Semantics       | Independent scheduled task             | Continuation of a conversation                     |
| Binding         | Space-scoped; not bound to any session | Bound to one session                               |
| Context at fire | Self-contained objective bundle        | The session's full transcript plus the cron prompt |
| Fire action     | Creates a new ticket                   | Wakes the bound session for a new turn             |
| Output          | A new thread / configured target       | The session's own thread                           |

## 2. Reminders

- Carry everything execution needs in the bundle: objective, context summary, required tags.
- At fire time the scheduler materializes the reminder as a ticket; from there it follows the normal ticket pipeline (any eligible worker, fresh worktree).
- Typical uses: "audit the repo every night", "check the dependency advisory feed hourly".

## 3. Crons

- Created by the agent mid-session via `CronCreate` / `CronList` / `CronDelete` tools. The interface takes only a cron expression, a prompt, and a recurring flag — session binding is implicit from the calling session.
- Crons are either **one-shot** (`recurring: false` — e.g. "check production an hour after the merge": fires once, then auto-deletes) or **recurring**.
- Records are stored server-side as durable entries in the session's event stream, and are cascade-deleted when the session closes. Workers hold no timers.
- At fire time the scheduler dispatches a `session.wakeup` to the bound worker: the cron prompt, wrapped in an origin envelope carrying scheduling metadata, starts a new turn in the existing context. Output streams to the session's thread.
- Typical uses: "poll CI until green, then continue", "check the deployment in 30 minutes and verify the page".

### Reliability Semantics

- **Busy sessions**: a fire due during an active turn is held and delivered at the next idle moment — never injected mid-turn.
- **Coalescing**: multiple missed fires collapse into a single delivery annotated with a `coalescedCount`; the agent treats it as "only the latest state matters".
- **Jitter**: deterministic per-job jitter spreads recurring fires to avoid thundering herds.
- **At-least-once**: when no worker is available, the fire queues server-side (coalescing) rather than dropping.
- **Staleness**: a recurring cron older than 7 days fires one final time marked `stale`, then is deleted — forgotten automation must never run forever, and the agent renews intent by recreating the cron. One-shot crons and reminders are exempt.

## 4. Timezones

- All records store and schedule in UTC.
- Each record carries a `timezone` (IANA name) defaulting to the **space's configured timezone** — never the worker's local timezone, since the server is authoritative.
- Cron expressions and timezone-naive inputs are interpreted in the record's timezone.
- Cron expressions are strictly 5-field; 6-field Quartz-style expressions are rejected.

## 5. Unified Trigger Model

User messages, reminders, crons, and webhooks all enter the same dispatch pipeline, distinguished only by their `source` and delivery semantics (`urgent` / `wait` / `if_idle`). The pipeline forks into exactly two paths:

- **Ticket dispatch** — builds a new execution context (reminders, webhooks, batch jobs).
- **Session wakeup** — resumes an existing context (crons, queued user turns).

Non-user triggers render as proactive messages in the thread rather than replies to a specific user message.
