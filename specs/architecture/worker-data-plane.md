# Worker Data Plane Architecture

The `meepo-worker` is a self-hosted runner daemon executing on developer machines, on-prem servers, or cloud sandboxes.

## Core Modules

### 1. Registration & Heartbeat
- Establishes a persistent outbound connection to `meepo-server` via WebSocket.
- Reports static capabilities: OS, architecture, installed toolchains (Node.js, Git, Go, Docker).
- Declares concurrency capacity: `maxSlots` (default `1` for laptops, configurable for dedicated boxes).
- Emits periodic heartbeats including active slot utilization, CPU/memory stats, and current task IDs.

### 2. Workspace & Git Worktree Manager
- Manages the local repository cache for assigned spaces.
- **Single-slot mode (`maxSlots = 1`)**:
  - Uses the primary workspace directory or a single task branch.
- **Multi-slot mode (`maxSlots > 1`)**:
  - Automatically provisions dedicated `git worktree` directories (`.meepo/worktrees/<session-id>`) per active task.
  - Ensures clean working directories without cross-task file conflicts or git locking issues.
  - Cleans up temporary worktrees upon session completion or timeout.

### 3. Agent Execution Engine
- Embeds `@earendil-works/pi-agent-core`'s `Agent` loop.
- Injects local tool operations using `@earendil-works/pi-coding-agent` abstractions:
  - `createReadTool` with local filesystem access.
  - `createWriteTool` with local directory creation.
  - `createEditTool` with exact string replacement diffing.
  - `createBashTool` with subprocess execution and streaming stdout/stderr.
- Subscribes to internal agent events and streams them back to the server:
  - `message_update` (text deltas).
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.
  - `turn_end` / `agent_end`.

### 4. Steering & Cancellation Handling
- Listens for server-initiated `abort` signals and cancels running tool child processes.
- Listens for server-initiated `steer` events (e.g. user follows up while bash command is running) and injects messages into the active `Agent` turn queue.
