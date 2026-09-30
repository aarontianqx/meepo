# Feature: Triggers & Scheduling

## 1. The Unified Model

MEEPO's execution domain answers exactly three questions:

```
Schedule ──fires──▶ Ticket | Turn ──executed as──▶ Run
```

| Noun         | Question                     | Definition                                                                                               |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Schedule** | When does work get produced? | The single scheduling entity: `timing` (`at` or `cron`) + `action` (`create_ticket` or `resume_session`) |
| **Ticket**   | What work? (independent)     | A self-contained objective bundle, executed in a fresh context; queueable, re-assignable, retryable      |
| **Turn**     | What work? (in-session)      | One continuation of an existing session, inheriting its context, pinned to its bound worker              |
| **Run**      | Who ran it, to what state?   | One execution attempt of a Ticket or a Turn                                                              |
| **Session**  | In which context?            | The window-bound conversation container (`main` / `thread`)                                              |

Retired concepts: **Reminder** and **CronJob** as entities (both are just `Schedule` actions), `cron` as a concept (it is only a time-expression syntax), `recurring` booleans (one-shot is `at`, recurring is `cron`), **wakeup** (a Turn whose source is a schedule fire), and `taskId` (it is `runId`).

## 2. Schedule

```typescript
interface Schedule {
  id: string;
  spaceId: string;
  timing: { kind: 'at'; at: number } | { kind: 'cron'; expression: string; timezone?: string };
  action:
    | {
        kind: 'create_ticket';
        objective: string;
        contextSummary?: string;
        requiredTags?: string[];
        originSessionId?: string;
      }
    | { kind: 'resume_session'; sessionId: string; prompt: string };
  status: 'active' | 'done' | 'deleted';
  createdByUserId: string;
  createdAt: number;
  lastFiredAt?: number;
}
```

- **`create_ticket`**: at fire time a new Ticket is materialized and dispatched. No staleness constraint.
- **`resume_session`**: at fire time a Turn is dispatched into the bound session, in the existing context. A recurring resume schedule older than 7 days fires one final time marked `stale`, then becomes `done` — forgotten automation must never run forever.

### Boundary Rules

- Timezones are taken from each record's `timezone` (DST handled by the cron library); schedules are stored in UTC.
- An `at` schedule fires once and becomes `done`; if the server was down at the fire time, it catches up exactly once at the next tick. Coalescing does not apply to `at`.
- Jitter is a deterministic per-schedule offset, at most 10% of the period and at most 15 minutes.
- `/new` cascade-deletes the session's `resume_session` schedules; `create_ticket` schedules are unaffected.
- Machine turns (schedule fires, ticket receipts) may also call `CronCreate` — recursion is allowed but bounded: at most 50 active schedules per session, and the 7-day stale rule above still applies.

### Reliability Semantics

- **Busy sessions**: a fire due during an active turn is held and delivered at the next idle moment — never injected mid-turn.
- **Coalescing**: multiple missed fires collapse into one, annotated with a `coalescedCount`.
- **Jitter**: deterministic per-schedule offset spreads recurring fires.
- **At-least-once**: when no worker is available, the fire queues server-side (coalescing) rather than dropping.

## 3. Ticket

A Ticket is the independent work unit. Its lifecycle:

```
pending → claimed → running → completed | failed | cancelled
```

- Self-contained by design: the objective bundle carries everything execution needs.
- Any eligible worker may claim it (no affinity). Each dispatch attempt carries an execution lease (`workerId` + `leaseExpiresAt`); a disconnected worker's ticket becomes re-dispatchable only after the lease expires, late results from expired attempts are rejected (logged only), and side-effecting work that cannot be safely retried is held for `manual_review` instead of auto-retrying. Every retry is a new Run with an incremented `attempt`.
- A ticket created from a session carries `originSessionId`, so its result can be reported back to that conversation.

## 4. Turn

A Turn is one continuation of a session. User messages, schedule fires (`resume_session`), webhooks, and proactive agent triggers all materialize as Turns, distinguished only by their `source` and delivery semantics (`urgent` / `wait` / `if_idle`). A Turn always routes to the session's bound worker and runs in the session's context.

## 5. Run

Every dispatch of a Ticket or a Turn to a worker creates a **Run**:

```typescript
interface Run {
  id: string;
  work:
    | { kind: 'ticket'; ticketId: string }
    | { kind: 'turn'; turnRef: { sessionId: string; sourceId: string } };
  attempt: number;
  workerId?: string;
  leaseExpiresAt?: number;
  status: 'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'merged' | 'dropped';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

Stream events, heartbeat `activeRunIds`, and execution state all hang off the Run. Every run ends with exactly one terminal state: turn-level `done` maps to `completed`; `interrupted` / `cancelled` / `error` map to `failed(reason)`. Runs pre-created for messages that are later merged close as `merged`; an `if_idle` delivery dropped on a busy session leaves a `dropped` record.

## 6. Agent-Facing Tools

The agent's scheduling tools map to the two action kinds, plus management of the session's own schedules:

- **`CronCreate` / `CronList` / `CronDelete`** — schedule, inspect, and cancel wakeups for the **current session** (`resume_session`): "continue this conversation later, with full context."
- **`TicketCreate`** — creates an **independent** task (`create_ticket`), immediately or on a timing rule: "runs in a fresh context with no access to this conversation."

The boundary is context continuity, never timing. Session and ticket tool sets are identical except for orchestration tools: sessions get `CronCreate` / `CronList` / `CronDelete` and `TicketCreate`; tickets get none — a ticket has no session to resume and cannot spawn further work.
