# Feature: Asynchronous Ticket Pipeline

## 1. Overview

While interactive sessions are optimized for synchronous dialogue, complex or deferred operations (multi-file refactorings, test suite runs, automated migrations, scheduled jobs) are modeled as **Tickets** — independent, self-contained work units.

## 2. Ticket Lifecycle

```text
Agent / HTTP / webhook / schedule → pending ticket → claimed attempt → running → result
```

Workers execute the supplied objective in a fresh neutral directory. Repository operations and publication are determined by that objective and the configured prompt, not an automatic ticket pipeline.

Every dispatch of a ticket creates a **Run**; a retry is a new Run with an incremented `attempt` and a fresh task directory (see `specs/features/triggers-and-scheduling.md`).

### Ticket State Transitions

| From                                                | Event                                          | To                      |
| --------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| `pending`                                           | claimed by a worker                            | `claimed`               |
| `pending`                                           | 24h unclaimed                                  | `failed(unclaimed)`     |
| `pending` / `claimed` / `running` / `manual_review` | user cancel                                    | `cancelled`             |
| `claimed`                                           | `run_started`                                  | `running`               |
| `claimed`                                           | lease lost before `run_started`, attempts left | `pending` (new attempt) |
| `running`                                           | agent completes                                | `completed`             |
| `running`                                           | agent errors                                   | `failed(error)`         |
| `running`                                           | lease expired; retry-eligible, attempts left   | `pending` (new attempt) |
| `running`                                           | lease expired; not retry-eligible              | `manual_review`         |
| `claimed` / `running`                               | lease expired; attempts exhausted              | `failed(max_attempts)`  |
| `manual_review`                                     | human retry                                    | `pending` (new attempt) |
| `manual_review`                                     | human abandon                                  | `failed(abandoned)`     |

`completed` / `failed` / `cancelled` are terminal. Manual retry accepts only `manual_review` with attempts remaining. `POST /api/tickets/:id/cancel` and the console Cancel ticket button also accept `running`. Repeated cancellation returns the same cancelled ticket and resends abort; completed/failed tickets reject cancellation with 409. When completion and cancellation race, the first committed transition wins; the other cannot overwrite it.

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
  /** Zero/absent before first dispatch; executions start at attempt 1. */
  attempt?: number;
  status:
    'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'manual_review';
  assignedWorkerId?: string;
  result?: { summary: string };
  pendingSince: number; // start of the most recent pending interval
  terminalReason?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

`completed` means the agent finished normally (not human acceptance); the ticket prompt requires a precise final summary, which becomes `result.summary`. Each attempt executes in a fresh task directory (`<ticketsDir>/<ticketId>/attempt-N`); previous attempts’ artifacts remain separate until worker directory retention reclaims them. The server execution trace remains durable.

Attempt-level retry is conservative: within the attempt limit, a never-started attempt may retry; a started attempt retries when the ticket was declared `idempotent: true` at creation, or when the previous attempt's persisted event stream shows only read-only tools (`read`/`grep`/`ls`/`glob`; `bash`, `write`, `edit`, and any MCP tool count as side-effectful). Otherwise it parks in `manual_review`, where a human resolves it from the console or API: **retry** (new attempt, fresh directory) or **abandon** (`failed(reason=abandoned)`). `maxAttempts = 3` — exhaustion ends as `failed(reason=max_attempts)`; a ticket pending for 24 hours ends as `failed(reason=unclaimed)`. The clock uses `pendingSince`, initialized at creation and reset on every manual or automatic retry into pending; unrelated updates do not extend it. SQLite migration backfills existing tickets from `updatedAt` (the previous implementation’s pending transition timestamp). Pending, claimed, running, and manual_review tickets can be cancelled from the console or API. Ticket bash subprocesses receive `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>`; MCP calls carry the same value in `_meta.meepoIdempotencyKey`, and the ticket prompt requires passing it as the idempotency key for external API calls.

Each run's execution stream — tool calls/results and final text, with streaming deltas excluded — is persisted server-side, keyed by `ticketId + attempt`, and is replayable from the console ticket detail page. The origin session's transcript receives only the receipt event (the result summary), never the execution detail. Receipt delivery follows the origin session's state: active → delivered as a `wait` turn (the agent responds in the window); busy → queued behind the active turn; closed → transcript only, no wake.

Tickets are a **generic async-task mechanism**: they may or may not involve a repository. Whether the objective touches code is expressed in the prompt itself — Meepo manages no repo bindings or worktrees for tickets (the agent handles repositories itself, per the system prompt rules). Repository credentials belong to the worker's own environment.

## 4. Triggers

A ticket is created by any of:

- **Console/API**: a space member creates a ticket through `POST /api/tickets`.
- **Agent intent**: the agent formalizes a request into a ticket via the `TicketCreate` tool.
- **Webhooks**: external systems (CI, monitoring) push events that materialize as tickets via `POST /api/webhooks/{spaceId}/tickets`, authenticated by a per-space Bearer secret (stored as a SHA-256 hash), or by the authenticated space member. Members issue/rotate or revoke it through `POST`/`DELETE /api/spaces/:id/webhook-token`; rotation invalidates the old token. Input fields are `title?`, `objective`, `contextSummary?`, `idempotent?`; the caller cannot forge an origin session. An `Authorization` header on this route is always interpreted as a webhook credential; current member access uses the local identity adapter without that header. SSO Bearer coexistence must be resolved when adding the SSO adapter. No broader external integration API is provided.
- **Schedule fires**: a `Schedule` with `action: create_ticket` materializes a fresh ticket at fire time (see `specs/features/triggers-and-scheduling.md`).

Tickets are exempt from session affinity: any enrolled, tag-matched worker with a free slot may claim a ticket.

## 5. Cancellation and receipt persistence

Cancellation first saves ticket state and fences its related runs in one SQLite transaction; the same transaction creates the origin receipt. The following abort notification targets those already-fenced runs by `terminalReason === 'cancelled'`. This ordering prevents stale events from restoring cancelled work while still stopping live worker execution. See the [server transaction contract](../architecture/server-control-plane.md#transaction-boundaries-and-cancellation-contract) for the repository adapter requirements.

Receipts use a stable ticket/attempt/status key. Terminal outcomes and lease loss requiring manual review notify the origin when one exists; automatic retries do not send a failure receipt on each attempt. No origin session means no receipt destination. A receipt triggers a session response through `wait` delivery, not direct replay of the ticket’s full tool trace.

Cancellation prevents further retries and requests worker interruption; it does not roll back files, messages or other effects already produced. Database cancellation is immediate, while local tool termination may take time. A disconnected worker is fenced immediately and aborts on lease loss/reconciliation. Ticket cancellation is available through Console/API; Feishu session Stop does not cancel independently created tickets.

### Creation controls

`idempotent:true` is an explicit retry-safety declaration on direct HTTP/API or webhook creation. Agent `TicketCreate`, `Schedule.action(create_ticket)` and the Console creation form do not expose it; these routes deliberately use the conservative read-only-trace retry policy. Do not infer idempotency from task prose. Extending those entry points requires an explicit product change.

Webhook `Idempotency-Key` deduplicates delivery requests within a space; it does not set `ticket.idempotent`. Same key plus same normalized payload returns the original ticket, including its current terminal state. A changed payload returns 409; absent keys create independent tickets. Keys persist without automatic TTL. Titles are limited to 200 characters; objectives and context summaries to 32,000 characters each. Webhook bodies are limited to 128 KiB and requests to 60/minute/space per server process.
