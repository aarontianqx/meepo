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

Every dispatch of a ticket creates a **Run**; a retry is a new Run with an incremented `attempt` (see `specs/features/triggers-and-scheduling.md`).

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
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  assignedWorkerId?: string;
  result?: {
    branch?: string;
    prUrl?: string;
    commitSha?: string;
    summary: string;
  };
  createdAt: number;
  completedAt?: number;
}
```

Tickets are a **generic async-task mechanism**: they may or may not involve a repository. Whether the objective touches code is expressed in the prompt itself — Meepo manages no repo bindings or worktrees for tickets (the agent handles repositories itself, per the system prompt rules). Repository credentials belong to the worker's own environment.

## 4. Triggers

A ticket is created by any of:

- **Agent intent**: the agent formalizes a request into a ticket via the `TicketCreate` tool.
- **Webhooks**: external systems (CI, monitoring) push events that materialize as tickets.
- **Schedule fires**: a `Schedule` with `action: create_ticket` materializes a fresh ticket at fire time (see `specs/features/triggers-and-scheduling.md`).

Tickets are exempt from session affinity: any enrolled, tag-matched worker with a free slot may claim a ticket.

## 5. Key Advantages

- **Clean Execution Context**: The worker receives a concise, curated `objective` rather than a sprawling 50-turn chat history.
- **Fault Tolerance**: If a worker disconnects mid-task, the ticket resets to `pending` and can be claimed by another worker.
- **Full Traceability**: Output commits, PR links, and token costs are cleanly tracked per ticket, and every execution attempt is recorded as a Run.
