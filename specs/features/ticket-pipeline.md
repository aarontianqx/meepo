# Feature: Asynchronous Ticket Pipeline

## 1. Overview

While interactive sessions are optimized for synchronous dialogue, complex coding operations (multi-file refactorings, test suite runs, automated migrations, scheduled jobs) are modeled as **Tickets**.

## 2. Ticket Lifecycle

```
[Trigger: Bot intent / Webhook / Reminder]
                 │
                 ▼
      [Create Ticket in Server]
        (Status: Pending)
                 │
                 ▼
     [Worker Claim / Dispatch]
        (Status: Running)
                 │
                 ▼
 [Worker Executes in Clean Worktree]
   - Checkout branch
   - Apply edits & run tests
   - Commit changes & push branch
   - Open Pull Request
                 │
                 ▼
     [Report Ticket Completion]
        (Status: Completed)
                 │
                 ▼
[Notify Feishu Thread with PR Link]
```

## 3. Data Model

```typescript
interface Ticket {
  id: string;
  spaceId: string;
  title: string;
  objective: string;
  contextSummary?: string;
  /** Repo binding for this ticket; falls back to the space default repo when absent */
  workspace?: { repoUrl: string; branch: string; commitSha?: string };
  requiredTags: string[];
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
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

The repo binding is **ticket-scoped**: which repository a task should touch is part of the objective bundle, not a space-global assumption. Repository credentials belong to the worker's own environment (the machine owner's git/SSH configuration) — the server never handles repo auth.

## 4. Triggers

A ticket is created by any of:

- **Bot intent**: the main assistant formalizes a user request into a ticket.
- **Webhooks**: external systems (CI, monitoring) push events that materialize as tickets.
- **Reminders**: a task-level scheduled trigger — a self-contained objective bundle plus a fire time or cron expression — creates a fresh ticket at fire time. Reminders are space-scoped and independent of any conversation (contrast with session crons; see `specs/features/triggers-and-scheduling.md`).

Tickets are exempt from session affinity: any enrolled, tag-matched worker with a free slot may claim a ticket.

## 5. Key Advantages

- **Clean Execution Context**: The worker receives a concise, curated `objective` rather than a sprawling 50-turn chat history.
- **Fault Tolerance**: If a worker disconnects mid-task, the ticket resets to `pending` and can be claimed by another worker.
- **Full Traceability**: Output commits, PR links, and token costs are cleanly tracked per ticket.
