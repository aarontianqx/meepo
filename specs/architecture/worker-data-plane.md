# Worker Data Plane Architecture

The `meepo-worker` is a self-hosted runner daemon executing on developer machines, on-prem servers, or cloud sandboxes. It is stateless across **ticket** lifetimes, but **sticky for sessions**: a session's agent process and workspace live on its bound worker for the session's whole lifetime.

## Core Modules

### 1. Registration & Heartbeat

- Establishes a persistent outbound connection to `meepo-server` via WebSocket.
- Authenticates with an enrollment token issued by any space member; the token alone determines which spaces the worker may serve.
- Generates its `workerId` at first boot and persists it in the data directory; the token binds to that `workerId` on first use and later mismatches are rejected — bindings and queued dispatches are restored against it on reconnect.
- Emits periodic heartbeats (15s) including active slot utilization, CPU/memory stats, and current run IDs (`activeRunIds`); each heartbeat renews the execution lease of the runs it carries in `activeRunIds` (lease = 3 heartbeat intervals — 45s at the default 15s — server clock authoritative). On connection loss the worker starts no new runs and suspends active ones past the lease window; on reconnect it reconciles runs with the server and kills any the server has invalidated.

### 2. Working Directories

- Owns the physical state of executions: per-task working directories and their contents. This local state is what makes session affinity a hard constraint, and it is never migrated implicitly.
- **Meepo manages no repositories**: sessions and tickets both start in a neutral per-task directory (`~/.meepo/sessions/<session-id>`, `~/.meepo/tickets/<ticketId>-attempt-N` — a fresh directory per ticket attempt, old attempts kept for audit). Whether a task involves a repo is a prompt-level concern — the agent clones or worktrees repositories itself. (The worktree-before-modifying-code rule lives in the optional _coding preset_, not in the universal base prompt.)
- Repository credentials belong to the worker's own environment (the machine owner's git/SSH configuration); neither plane ever handles repo auth.
- Working directories are reclaimed after 7 days, and a `session.closed` notification reclaims the session's local resources immediately; a directory is abandoned only through an explicit, state-losing rebind initiated by the user.

### 3. Agent Execution Engine

- Embeds `@earendil-works/pi-agent-core`'s `Agent` loop; model credentials resolve from the server's model registry (space references a `modelId`) and are injected per dispatch (TLS on the worker channel is a prerequisite for real credentials).
- Sessions stay warm: the agent process may outlive a turn. After TTL eviction or a worker restart, the session cold-starts from the server-provided snapshot.
- **System prompt = universal skeleton + optional domain presets**: identity/runtime (bot name, time, workdir) + space memory index + skills (`~/.agents/skills/` descriptions) + channel info. Domain presets (e.g. the coding preset with worktree discipline) are opt-in per space, never hardcoded into the base. The rendered prompt is snapshotted at session creation so resumes don't drift — the freeze covers identity, presets, and tool descriptions; the directory-level Memory Map is a separately versioned suffix block, re-rendered at cold starts (new session, TTL eviction, `/new`) and recorded with each snapshot.
- Effective timing is split three ways: identity/preset/tool descriptions are frozen for the session's lifetime; memory is retrieved live via tools, never injected; the wall-clock time is frozen in the prompt snapshot while the current time rides in each turn's envelope (machine turns' origin envelopes included) — the prompt stays cache-stable without the agent losing track of elapsed time.
- Injects local tool operations using `@earendil-works/pi-coding-agent` abstractions:
  - `createReadTool` with local filesystem access.
  - `createWriteTool` with local directory creation.
  - `createEditTool` with exact string replacement diffing.
  - `createBashTool` with subprocess execution and streaming stdout/stderr.
  - Custom tools are attachable via MCP servers (stdio or remote), configured in the worker's own config file by the worker owner; the server never provisions tool processes. Tools are namespaced `mcp__<server>__<tool>` and honor `timeoutSeconds` and abort. Config hot-reload applies to subsequently started sessions and cold-starts; a warm session keeps its tool set for its lifetime; a failed reload keeps the previous config and logs an error.
- Subscribes to internal agent events and streams them back to the server:
  - `message_update` (text deltas).
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.
  - `turn_end` / `agent_end`.
- Media normalization is worker-side: images referenced in the transcript are downloaded directly from the channel (credentials injected at dispatch), materialized into the session's `.media/` directory, and downscaled only on the model-bound copy.

### 4. Delivery, Steering & Wakeup

- Applies three delivery semantics to incoming work: `urgent` (end the active turn — run `interrupted` — and start a new one), `wait` (queue behind it), `if_idle` (drop when busy, leaving a `dropped` run record). Consecutive queued messages may merge into a single turn; runs pre-created for messages later merged are closed as `merged`.
- Handles `turn.dispatch` envelopes (user turns and schedule fires): cold-starts the session from the server snapshot if needed, then runs a turn in the restored context.
- Listens for server-initiated `abort` signals and cancels running tool child processes.

### 5. Server-Backed Tools

- Scheduling tools (`CronCreate` / `CronList` / `CronDelete` for session wakeups, `TicketCreate` for independent tasks) proxy to the server; schedule records live server-side. The worker holds no timers or scheduler of its own.
- **Memory tools** (`MemoryList` / `MemorySearch` / `MemoryRead` / `MemoryWrite` / `MemoryDelete`) proxy to the server; the system prompt carries a directory-level Memory Map snapshot (frozen at session creation, possibly stale — the tools always return current data), and writes are guarded by `expected_revision` optimistic locking.
- Context tools (history, space memory) query the server rather than local state, keeping the worker free of authoritative data.
