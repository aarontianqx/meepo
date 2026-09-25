# System Overview Architecture

## 1. High-Level Architecture

MEEPO decomposes the agentic team assistant problem into an asynchronous, capacity-routed system:

```
+-----------------------------------------------------------------------------------+
|                                  Feishu Platform                                  |
|               (Dev Chat / Support Chat / Operations Chat / Threads)               |
+-----------------------------------------------------------------------------------+
                                         │
                        Feishu WebSocket / Webhook
                                         ▼
+-----------------------------------------------------------------------------------+
|                        MEEPO Central Server (Control Plane)                       |
|                                                                                   |
|  [ Feishu Gateway ] ──> [ Space & Memory Manager ] ──> [ Dispatcher ]             |
|          │                            │                             │             |
|          ▼                            ▼                             ▼             |
|  [ Card Streamer ]          [ Session Store (SST) ]       [ Ticket Queue ]        |
|                                                                                   |
|  [ Auth (edge JWT) ]              [ Scheduler (reminders & crons) ]               |
+-----------------------------------------------------------------------------------+
                                         │
                           RPC WebSocket Stream (CBOR/JSON)
                                         ▼
+-----------------------------------------------------------------------------------+
|                         MEEPO Worker Fleet (Data Plane)                           |
|                                                                                   |
|   ┌───────────────────────────┐                  ┌────────────────────────────┐   |
|   │   Private Physical Node   │                  │    Cloud Sandbox Node      │   |
|   │ (MacBook / On-Prem Box)   │                  │   (Dynamic Docker / K8s)   │   |
|   │  - Slots: 1               │                  │  - Slots: 4                │   |
|   │  - Git Worktree: Default  │                  │  - Worktrees: Isolated     │   |
|   │  - Pi Agent Core Runner   │                  │  - Pi Agent Core Runner    │   |
|   │  - Local Tools: Read/Bash │                  │  - Local Tools: Read/Bash  │   |
|   └───────────────────────────┘                  └────────────────────────────┘   |
+-----------------------------------------------------------------------------------+
```

## 2. Architectural Invariants

1. **Server Never Directly Modifies Repositories**: The control plane never executes local shell commands or modifies local workspace files. All disk and execution operations are delegated to workers.
2. **Server Owns Truth; Worker Owns Live State**: The server is the single source of truth for space configuration, long-term memory, session transcripts, and ticket state. The worker owns what is inherently local: the agent process, the git workspace, and uncommitted changes. A worker crash never loses conversational data.
3. **Strict Space Boundary**: Chat messages and agent actions are always fenced by the containing `Space`. A worker assigned to Space A cannot access Space B's long-term memory or session state.
4. **Capacity-Aware Concurrency**: Workers register explicit concurrency slots. Tasks are never assigned to a worker beyond its registered slot limits.
5. **Hard Session–Worker Affinity**: A session is bound to one worker at creation and always routes back to it while that worker remains enrolled — its workspace and uncommitted state live there. A bound worker going offline pauses the session (messages queue server-side); it never triggers silent migration. Rebinding is always a deliberate user action. Tickets are exempt: they run in fresh worktrees and may be re-queued to any eligible worker.
6. **Identity at the Edge**: User authentication happens at the edge (SSO); the server verifies the signed token and extracts the user's identity (`userId`). MEEPO maintains no account system of its own — the only authorization data it owns is space membership (one role per user per space).

## 3. Multi-Tenancy & Worker Enrollment

The deployment is centrally operated; spaces and workers join freely:

```
[User via edge SSO]                    [Space Owner]
        │                                     │ issues enrollment token
        ▼                                     ▼
  meepo-server  <──── worker.register(token) ────  meepo-worker
        │
        └─ Space: membership (userId→role) + boundWorkerId (console-configured)
```

### Domain Glossary

The execution domain has exactly five nouns:

- **Schedule** — when work gets produced (`timing` + `action: create_ticket | resume_session`).
- **Ticket** — an independent, self-contained work unit (queueable, retryable).
- **Turn** — one continuation of an existing session.
- **Run** — one execution attempt of a Ticket or a Turn.
- **Session** — a window-bound conversation container (`main` / `thread`).

Everything else is an attribute or an action, not a concept.

- **Space is the tenant**: context, memory, sessions, and tickets are isolated per space. Access is governed by space membership keyed to the SSO `userId` — every member may administer the space, and exactly one member is the `owner`.
- **Worker Enrollment Tokens** (`mep_...`) are issued by a space owner for a chosen set of spaces. At registration the worker presents only its token; the server resolves the authorized space set (`WorkerNode.spaceIds`). Workers never self-select spaces.
- **Space Worker Binding** (`Space.boundWorkerId`): each space designates the worker that hosts its main sessions; thread sessions dispatch to a randomly chosen enrolled worker at creation, then stay pinned. See `specs/features/space-and-chat.md` for the full binding and migration semantics.
- The dispatcher only ever routes a space's work to workers enrolled for that space (tag matching applies as a secondary filter).
