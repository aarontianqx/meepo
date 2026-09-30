# Feature: Asynchronous Ticket Pipeline

## 1. Overview

While interactive sessions are optimized for synchronous dialogue, complex or deferred operations (multi-file refactorings, test suite runs, automated migrations, scheduled jobs) are modeled as **Tickets** — independent, self-contained work units.

## 2. Ticket Lifecycle

```
[Trigger: Agent intent / Webhook / Schedule fire]
                 │
                 ▼
      [Create Ticket in Server]
        (Status: Pending)
                 │
                 ▼
     [Worker Claim / Run Dispatch]
        (Status: Running)
                 │
                 ▼
 [Worker Executes in Neutral Task Directory]
   (example coding flow — tickets are repo-agnostic)
   - Clone/worktree repos on demand
   - Apply edits & run tests
   - Commit changes & push branch
   - Open Pull Request
                 │
                 ▼
     [Report Ticket Completion]
        (Status: Completed)
                 │
                 ▼
[Notify Origin Session / Feishu Thread]
```

Every dispatch of a ticket creates a **Run**; a retry is a new Run with an incremented `attempt` and a fresh task directory (see `specs/features/triggers-and-scheduling.md`).

### Ticket State Transitions

| From | Event | To |
| --- | --- | --- |
| `pending` | claimed by a worker | `claimed` |
| `pending` | 24h unclaimed | `failed(unclaimed)` |
| `pending` / `claimed` / `manual_review` | user cancel | `cancelled` |
| `claimed` | `run_started` | `running` |
| `claimed` | lease lost before `run_started` | `pending` (re-dispatch) |
| `running` | agent completes | `completed` |
| `running` | agent errors | `failed(error)` |
| `running` | lease expired; retry-eligible, attempts left | `pending` (new attempt) |
| `running` | lease expired; not retry-eligible | `manual_review` |
| `running` | lease expired; attempts exhausted | `failed(max_attempts)` |
| `manual_review` | human retry | `pending` (new attempt) |
| `manual_review` | human abandon | `failed(abandoned)` |

`completed` / `failed` / `cancelled` are terminal.

## 3. Data Model

```typescript
interface Ticket {
  id: string;
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  requiredTags: string[];
  /** Session the result reports back to, when created from one */
  originSessionId?: string;
  /** Declares the ticket safely re-runnable */
  idempotent?: boolean;
  /** Current attempt number (1-based) */
  attempt: number;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'manual_review';
  assignedWorkerId?: string;
  result?: { summary: string };
  createdAt: number;
  completedAt?: number;
}
```

`completed` means the agent finished normally (not human acceptance); the ticket prompt requires a precise final summary, which becomes `result.summary`. Each attempt executes in a fresh task directory (`<ticketId>-attempt-N`); previous attempts' artifacts stay in their own directories for audit.

Attempt-level retry is conservative: a ticket auto-retries when it was declared `idempotent: true` at creation, or when the previous attempt's persisted event stream shows only read-only tools (`read`/`grep`/`ls`/`glob`; `bash`, `write`, `edit`, and any MCP tool count as side-effectful). Otherwise it parks in `manual_review`, where a human resolves it from the console or API: **retry** (new attempt, fresh directory) or **abandon** (`failed(reason=abandoned)`). `maxAttempts = 3` — exhaustion ends as `failed(reason=max_attempts)`; a ticket pending over 24 hours ends as `failed(reason=unclaimed)`. Pending, claimed, and manual_review tickets can be cancelled from the console or API. Ticket runs receive `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>` in their tool environment, and the ticket prompt requires passing it as the idempotency key for external API calls.

Each run's execution stream — tool calls/results and final text, with streaming deltas excluded — is persisted server-side, keyed by `ticketId + attempt`, and is replayable from the console ticket detail page. The origin session's transcript receives only the receipt event (the result summary), never the execution detail. Receipt delivery follows the origin session's state: active → delivered as a `wait` turn (the agent responds in the window); busy → queued behind the active turn; closed → transcript only, no wake.

Tickets are a **generic async-task mechanism**: they may or may not involve a repository. Whether the objective touches code is expressed in the prompt itself — Meepo manages no repo bindings or worktrees for tickets (the agent handles repositories itself, per the system prompt rules). Repository credentials belong to the worker's own environment.

## 4. Triggers

A ticket is created by any of:

- **Agent intent**: the agent formalizes a request into a ticket via the `TicketCreate` tool.
- **Webhooks**: external systems (CI, monitoring) push events that materialize as tickets via `POST /api/webhooks/{spaceId}/tickets`, authenticated by a per-space webhook secret. No broader open API is provided.
- **Schedule fires**: a `Schedule` with `action: create_ticket` materializes a fresh ticket at fire time (see `specs/features/triggers-and-scheduling.md`).

Tickets are exempt from session affinity: any enrolled, tag-matched worker with a free slot may claim a ticket.

## 5. Key Advantages

- **Clean Execution Context**: The worker receives a concise, curated `objective` rather than a sprawling 50-turn chat history.
- **Fault Tolerance**: If a worker disconnects mid-task, the ticket becomes re-dispatchable once the attempt's lease expires (late results from expired attempts are rejected). Attempt-level retry is conservative: never-started attempts re-dispatch automatically; started attempts re-dispatch only when declared `idempotent: true` or proven read-only by their persisted event stream; otherwise the ticket parks in `manual_review` for human resolution (retry / abandon).
- **Full Traceability**: every execution attempt is recorded as a Run with its own task directory and persisted event stream, and the final summary is reported back to the origin.
