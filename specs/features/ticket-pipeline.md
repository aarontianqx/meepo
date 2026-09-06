# Feature: Asynchronous Ticket Pipeline

## 1. Overview

While interactive sessions are optimized for synchronous dialogue, complex coding operations (multi-file refactorings, test suite runs, automated migrations, Cron jobs) are modeled as **Tickets**.

## 2. Ticket Lifecycle

```
[Trigger: Bot intent / Webhook / Cron]
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
  requiredTags: string[];
  status: "pending" | "claimed" | "running" | "completed" | "failed";
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

## 4. Key Advantages

- **Clean Execution Context**: The worker receives a concise, curated `objective` rather than a sprawling 50-turn chat history.
- **Fault Tolerance**: If a worker disconnects mid-task, the ticket resets to `pending` and can be claimed by another worker.
- **Full Traceability**: Output commits, PR links, and token costs are cleanly tracked per ticket.
