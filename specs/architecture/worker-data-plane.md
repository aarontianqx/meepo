# Worker Data Plane Architecture

The `meepo-worker` is a self-hosted runner daemon executing on developer machines, on-prem servers, or cloud sandboxes. It is stateless across **ticket** lifetimes, but **sticky for sessions**: a session's agent process and workspace live on its bound worker for the session's whole lifetime.

## Core Modules

### 1. Registration & Heartbeat

- Establishes a persistent outbound connection to `meepo-server` via WebSocket.
- Authenticates with an enrollment token issued by a space owner; the token alone determines which spaces the worker may serve.
- Uses a stable `workerId` persisted across restarts — bindings and queued dispatches are restored against it on reconnect.
- Emits periodic heartbeats including active slot utilization, CPU/memory stats, and current task IDs.

### 2. Workspace & Git Worktree Manager

- Owns the physical state of sessions: repository checkouts, worktrees, uncommitted changes, and dependency caches. This local state is what makes session affinity a hard constraint, and it is never migrated implicitly.
- **Single-slot mode (`maxSlots = 1`)**:
  - Uses the primary workspace directory or a single task branch.
- **Multi-slot mode (`maxSlots > 1`)**:
  - Automatically provisions dedicated `git worktree` directories (`.meepo/worktrees/<session-id>`) per active task.
  - Ensures clean working directories without cross-task file conflicts or git locking issues.
- Reclaims worktrees when their session closes or times out; a workspace is abandoned only through an explicit, state-losing rebind initiated by the user.

### 3. Agent Execution Engine

- Embeds `@earendil-works/pi-agent-core`'s `Agent` loop; model credentials are held per space by the server and injected per dispatch (TLS on the worker channel is a prerequisite for real credentials).
- Sessions stay warm: the agent process may outlive a turn. After TTL eviction or a worker restart, the session cold-starts from the server-provided snapshot.
- Injects local tool operations using `@earendil-works/pi-coding-agent` abstractions:
  - `createReadTool` with local filesystem access.
  - `createWriteTool` with local directory creation.
  - `createEditTool` with exact string replacement diffing.
  - `createBashTool` with subprocess execution and streaming stdout/stderr.
- Subscribes to internal agent events and streams them back to the server:
  - `message_update` (text deltas).
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.
  - `turn_end` / `agent_end`.

### 4. Delivery, Steering & Wakeup

- Applies three delivery semantics to incoming work: `urgent` (steer into the active turn), `wait` (queue behind it), `if_idle` (drop when busy). Consecutive queued messages may merge into a single turn.
- Handles `session.wakeup` envelopes (cron fires): cold-starts the session from the server snapshot if needed, then runs a turn in the restored context.
- Listens for server-initiated `abort` signals and cancels running tool child processes.

### 5. Server-Backed Tools

- Cron tools (`CronCreate` / `CronList` / `CronDelete`) proxy to the server; cron records live server-side, scoped to the calling session. The worker holds no timers or scheduler of its own.
- Context tools (history, space memory) query the server rather than local state, keeping the worker free of authoritative data.
