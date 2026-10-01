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

- `at` is an epoch-millisecond instant; `cron` uses a strictly five-field expression and `timing.timezone`, with DST handled by Croner. Stored timestamps are UTC.
- An `at` schedule fires once and becomes `done`; if the server was down at the fire time, it catches up exactly once at the next tick. Coalescing does not apply to `at`.
- Jitter is a deterministic per-schedule offset, at most 10% of the period and at most 15 minutes.
- `/new` cascade-deletes the session's `resume_session` schedules; `create_ticket` schedules are unaffected.
- The default timezone is the space's configured timezone, or UTC when unset.
- Agent-created schedules derive `createdByUserId` from the first persisted run initiator; machine turns use `agent`. Console-created schedules use authenticated request identity.
- Intended prompt policy: interactive ambiguity should be clarified with the user; unattended ambiguity should default to a self-contained ticket with stated assumptions. Current tool descriptions explain context continuity, but do not yet explicitly encode the unattended fallback; this remains a prompt-policy gap, not a server-enforced rule.
- Machine turns (schedule fires, ticket receipts) may also call `CronCreate` — recursion is allowed but bounded: at most 50 active resume schedules per session, and the 7-day stale rule above still applies. Renewal is explicit creation of a new schedule after the final stale fire; there is no implicit TTL extension.

### Reliability Semantics

- **Atomic creation**: a schedule fire and the creation of its work item commit in one transaction — a crash can neither lose the fire nor leave an unidentifiable duplicate. External side effects are never exactly-once by construction.
- **Busy sessions**: a fire due during an active turn is held and delivered at the next idle moment — never injected mid-turn.
- **Coalescing**: multiple missed fires collapse into one, annotated with a `coalescedCount`.
- **Jitter**: deterministic per-schedule offset spreads recurring fires.
- **At-least-once**: when no worker is available, the fire queues server-side (coalescing) rather than dropping.

## 3. Ticket

A Ticket is a self-contained objective, dispatched to any enrolled, tag-matched worker with capacity. Each execution attempt has its own run and directory. Model-call retry, tool outcomes and ticket-attempt retry are separate layers: the harness does not blindly retry failed tools; ticket retry follows persisted evidence and explicit idempotency.

The complete [ticket state machine](ticket-pipeline.md) owns cancellation, manual_review resolution, the three-attempt limit, `pendingSince` timeout and origin receipts. Lease renewal and event rejection are defined in the [worker protocol](../architecture/worker-protocol.md).

## 4. Turn

A Turn is one continuation of a session. User messages, console injections, ticket receipts and schedule fires (`resume_session`) materialize as Turns. These producers all use `wait`; `urgent` and `if_idle` are reserved protocol modes. The current webhook endpoint creates tickets, not session turns. A Turn always routes to the session's bound worker and runs in the session's context.

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
  terminalReason?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

Stream events, heartbeat `activeRunIds`, and execution state all hang off the Run. Every run ends with exactly one terminal state: turn-level `done` maps to `completed`; `interrupted` / `cancelled` / `error` map to `failed(reason)`. Runs pre-created for messages that are later merged close as `merged`; an `if_idle` delivery dropped on a busy session leaves a `dropped` record.

### Run State Transitions

| From                                | Event                                              | To                                                                                              |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `queued`                            | dispatched to a worker                             | `dispatched`                                                                                    |
| `queued`                            | merged before dispatch                             | `merged` (`mergedIntoRunId` set)                                                                |
| `queued`                            | `if_idle` drop on a busy session                   | `dropped`                                                                                       |
| `dispatched`                        | `run_started`                                      | `running`                                                                                       |
| `dispatched`                        | lease lost before start                            | `failed(worker_lost)`; ticket retry may create a new run within its attempt limit               |
| `running`                           | turn completes                                     | `completed`                                                                                     |
| `running`                           | interrupted / cancelled / error                    | `failed(reason)`                                                                                |
| `queued` / `dispatched` / `running` | applicable interrupt (Stop, close, rebind, `/new`) | `failed(interrupted)`; rebind migrates queued/dispatched main inputs instead of cancelling them |
| `queued` / `dispatched` / `running` | eligible ticket cancellation                       | `failed(cancelled)`; ticket becomes cancelled                                                   |

## 6. Agent-Facing Tools

The agent's scheduling tools map to the two action kinds, plus management of the session's own schedules:

- **`CronCreate` / `CronList` / `CronDelete`** — schedule, inspect, and cancel wakeups for the **current session** (`resume_session`): "continue this conversation later, with full context."
- **`TicketCreate`** — creates an **independent** task (`create_ticket`), immediately or on a timing rule: "runs in a fresh context with no access to this conversation."

The boundary is context continuity, never timing. Session and ticket tool sets are identical except for orchestration tools: sessions get `CronCreate` / `CronList` / `CronDelete` and `TicketCreate`; tickets get none — a ticket has no session to resume and cannot spawn further work.
