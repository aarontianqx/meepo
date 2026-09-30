# Worker Data Plane Architecture

The `meepo-worker` is a self-hosted runner daemon executing on developer machines, on-prem servers, or cloud sandboxes. It is stateless across **ticket** lifetimes, but **sticky for sessions**: a session's agent process and workspace live on its bound worker for the session's whole lifetime.

## Core Modules

### 1. Registration & Heartbeat

- Establishes a persistent outbound connection to `meepo-server` via WebSocket.
- Authenticates with an enrollment token issued by a space owner; the token alone determines which spaces the worker may serve.
- Uses a stable `workerId` persisted across restarts — bindings and queued dispatches are restored against it on reconnect.
- Emits periodic heartbeats including active slot utilization, CPU/memory stats, and current task IDs.

### 2. Working Directories

- Owns the physical state of executions: per-task working directories and their contents. This local state is what makes session affinity a hard constraint, and it is never migrated implicitly.
- **Meepo manages no repositories**: sessions and tickets both start in a neutral per-task directory (`~/.meepo/sessions/<session-id>`, `~/.meepo/tickets/<ticket-id>`). Whether a task involves a repo is a prompt-level concern — the agent clones or worktrees repositories itself. (The worktree-before-modifying-code rule lives in the optional _coding preset_, not in the universal base prompt.)
- Repository credentials belong to the worker's own environment (the machine owner's git/SSH configuration); neither plane ever handles repo auth.
- Working directories of closed sessions are reclaimed on a retention policy; a directory is abandoned only through an explicit, state-losing rebind initiated by the user.

### 3. Agent Execution Engine

- Embeds `@earendil-works/pi-agent-core`'s `Agent` loop; model credentials resolve from the server's model registry (space references a `modelId`) and are injected per dispatch (TLS on the worker channel is a prerequisite for real credentials).
- Sessions stay warm: the agent process may outlive a turn. After TTL eviction or a worker restart, the session cold-starts from the server-provided snapshot.
- **System prompt = universal skeleton + optional domain presets**: identity/runtime (bot name, time, workdir) + space memory index + skills (`~/.agents/skills/` descriptions) + channel info. Domain presets (e.g. the coding preset with worktree discipline) are opt-in per space, never hardcoded into the base. The rendered prompt is snapshotted at session creation so resumes don't drift.
- Injects local tool operations using `@earendil-works/pi-coding-agent` abstractions:
  - `createReadTool` with local filesystem access.
  - `createWriteTool` with local directory creation.
  - `createEditTool` with exact string replacement diffing.
  - `createBashTool` with subprocess execution and streaming stdout/stderr.
  - Custom tools are attachable via MCP servers (space-configured).
- Subscribes to internal agent events and streams them back to the server:
  - `message_update` (text deltas).
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.
  - `turn_end` / `agent_end`.

### 4. Delivery, Steering & Wakeup

- Applies three delivery semantics to incoming work: `urgent` (steer into the active turn), `wait` (queue behind it), `if_idle` (drop when busy). Consecutive queued messages may merge into a single turn.
- Handles `turn.dispatch` envelopes (user turns and schedule fires): cold-starts the session from the server snapshot if needed, then runs a turn in the restored context.
- Listens for server-initiated `abort` signals and cancels running tool child processes.

### 5. Server-Backed Tools

- Scheduling tools (`CronCreate` / `CronList` / `CronDelete` for session wakeups, `TicketCreate` for independent tasks) proxy to the server; schedule records live server-side. The worker holds no timers or scheduler of its own.
- **Memory tools** (list/search/read/write the space's memory entries) proxy to the server; the worker reads the memory index from the system prompt and fetches full entries on demand.
- Context tools (history, space memory) query the server rather than local state, keeping the worker free of authoritative data.
