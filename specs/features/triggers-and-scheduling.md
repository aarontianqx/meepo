# Feature: Triggers & Scheduling

## 1. The Unified Model

MEEPO's execution domain answers exactly three questions:

```
Schedule ──fires──▶ Ticket | Turn ──executed as──▶ Run
```

| Noun | Question | Definition |
|---|---|---|
| **Schedule** | When does work get produced? | The single scheduling entity: `timing` (`at` or `cron`) + `action` (`create_ticket` or `resume_session`) |
| **Ticket** | What work? (independent) | A self-contained objective bundle, executed in a fresh context; queueable, re-assignable, retryable |
| **Turn** | What work? (in-session) | One continuation of an existing session, inheriting its context, pinned to its bound worker |
| **Run** | Who ran it, to what state? | One execution attempt of a Ticket or a Turn |
| **Session** | In which context? | The window-bound conversation container (`main` / `thread`) |

Retired concepts: **Reminder** and **CronJob** as entities (both are just `Schedule` actions), `cron` as a concept (it is only a time-expression syntax), `recurring` booleans (one-shot is `at`, recurring is `cron`), **wakeup** (a Turn whose source is a schedule fire), and `taskId` (it is `runId`).

## 2. Schedule

```typescript
interface Schedule {
  id: string;
  spaceId: string;
  timing:
    | { kind: 'at'; at: number }
    | { kind: 'cron'; expression: string; timezone?: string };
  action:
    | { kind: 'create_ticket'; objective: string; contextSummary?: string;
        requiredTags?: string[]; originSessionId?: string }
    | { kind: 'resume_session'; sessionId: string; prompt: string };
  status: 'active' | 'done' | 'deleted';
  createdByUserId: string;
  createdAt: number;
  lastFiredAt?: number;
}
```

- **`create_ticket`**: at fire time a new Ticket is materialized and dispatched. No staleness constraint.
- **`resume_session`**: at fire time a Turn is dispatched into the bound session, in the existing context. A recurring resume schedule older than 7 days fires one final time marked `stale`, then becomes `done` — forgotten automation must never run forever.

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
- Any eligible worker may claim it (no affinity); on worker disconnect it returns to `pending` and another worker picks it up — each retry is a new Run with an incremented `attempt`.
- A ticket created from a session carries `originSessionId`, so its result can be reported back to that conversation.

## 4. Turn

A Turn is one continuation of a session. User messages, schedule fires (`resume_session`), webhooks, and proactive agent triggers all materialize as Turns, distinguished only by their `source` and delivery semantics (`urgent` / `wait` / `if_idle`). A Turn always routes to the session's bound worker and runs in the session's context.

## 5. Run

Every dispatch of a Ticket or a Turn to a worker creates a **Run**:

```typescript
interface Run {
  id: string;
  work: { kind: 'ticket'; ticketId: string } | { kind: 'turn'; sessionId: string };
  attempt: number;
  workerId?: string;
  status: 'queued' | 'dispatched' | 'running' | 'completed' | 'failed';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

Stream events, heartbeat `activeRunIds`, and execution state all hang off the Run. Every run ends with exactly one terminal state.

## 6. Agent-Facing Tools

The agent sees exactly two scheduling tools, one per action kind:

- **`CronCreate`** — schedules a wakeup for the **current session** (`resume_session`): "continue this conversation later, with full context."
- **`TicketCreate`** — creates an **independent** task (`create_ticket`), immediately or on a timing rule: "runs in a fresh context with no access to this conversation."

The boundary is context continuity, never timing.
