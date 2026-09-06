# Proposal: MEEPO Architecture & System Design

- **Date**: 2026-09-06
- **Status**: Accepted (Initial Foundation)
- **Author**: Aaron Tian
- **Title**: MEEPO (Multi-worker Execution Engine for Project-isolated Orchestration)

---

## 1. Background & Context

In modern software organizations, AI coding assistants are rapidly evolving from personal CLI companions (like Claude Code, Cursor, Pi) into team-wide collaborative agents embedded in Instant Messaging platforms (such as Feishu/Lark).

However, integrating coding agents into team IM environments introduces significant engineering challenges:
1. **Multi-Channel & Project Boundaries**: A single project/repository often spans multiple IM groups (e.g., an internal R&D group, a customer support group, an operations group). Context and memory must be shared across these groups, yet strictly isolated from other projects.
2. **Execution Environment Divergence**: Some tasks require executing proprietary code on specific private developer laptops or on-premise physical servers, while others run safely in dynamic ephemeral cloud sandboxes.
3. **Heavy Compute vs. Lightweight Gateway**: Running complete coding agent loops (with intensive file I/O, compilation, local test execution, and bash execution) inside a central IM server creates huge network/I/O bottlenecks, single points of failure, and security risks.
4. **Interactive Chat vs. Background Tasks**: Users need both interactive real-time exploration (e.g. asking the bot to inspect a file and run a command in a thread) and heavy background batch jobs (e.g. fixing a bug, creating a PR, running cron audits).

**MEEPO** (**M**ulti-worker **E**xecution **E**ngine for **P**roject-isolated **O**rchestration) is designed as a decoupled, multi-worker agent orchestration framework solving these challenges.

---

## 2. Core Architectural Decisions

### 2.1 Control Plane vs. Data Plane Separation

MEEPO strictly divides responsibilities into two planes:

```
[ Feishu Client (Chats & Threads) ]
                │
                ▼
┌────────────────────────────────────────────────────────┐
│             Control Plane: meepo-server                │
│  - Feishu Event Gateway (Webhook / WebSocket)          │
│  - Space & Chat Relationship Registry                  │
│  - Authoritative Long-Term Memory & Session Store      │
│  - Capacity-Aware Dispatcher & Load Balancer           │
│  - Asynchronous Ticket Queue                           │
└──────────────────────────┬─────────────────────────────┘
                           │ Protocol Envelopes (WebSocket / RPC)
                           ▼
┌────────────────────────────────────────────────────────┐
│              Data Plane: meepo-worker                  │
│  - Long-running Runner Daemon (Physical / Sandbox)     │
│  - Local Git Worktree & Dependency Cache               │
│  - Embedded Pi Runtime (@earendil-works/pi-agent-core) │
│  - Slot-based Concurrency Isolation                    │
│  - Streaming Event Emitter (Deltas, Tool Executions)   │
└────────────────────────────────────────────────────────┘
```

- **Thick Worker (Data Plane)**: The worker runs adjacent to the actual code. It embeds `@earendil-works/pi-agent-core` and executes `read`, `write`, `edit`, and `bash` tools against local storage with zero network file-transfer latency.
- **Thin Server (Control Plane)**: The server acts strictly as the router, authoritative state keeper, and card streamer. It does not mount repositories or execute shell commands.

### 2.2 Domain Hierarchies: Space, Chat, Thread, and Session

The model decouples business communication from computational sessions:

```
Space (Project Boundary, e.g. "earendil-pi")
  ├── Long-term Memory Store (Specs, Architecture notes, Common traps)
  ├── Git Repository Config (Repo URL, Base branches, CI hooks)
  ├── Bound Chat Groups
  │     ├── R&D Chat (chat_id: dev-01)
  │     └── Support Chat (chat_id: support-01)
  └── Worker Tag Requirements (e.g. [macos, private, node22])
```

- **1 Space $\leftrightarrow$ N Chats**: An arbitrary number of chat groups can point to the same Space. A question asked in the Support chat shares the exact same architectural memory as the R&D chat.
- **1 Thread $\leftrightarrow$ 1 Session**: In Feishu, replying to a message thread (`root_id`) maintains an active interactive session. All turns in that thread correlate to the same session ID.
- **Worker Statelessness**: The authoritative message transcript is streamed back and persisted in `meepo-server`. Workers are stateless execution runtimes that receive session state on demand.

### 2.3 Dual Interaction Models

To satisfy both low-latency conversation and heavy background execution, MEEPO implements two operating models:

#### Mode A: Interactive Streaming Session (Thread-bound)
1. User `@bot` in a Feishu thread with a query.
2. Server's **Capacity-aware Dispatcher** routes the thread to an available worker holding the project's workspace, respecting session affinity.
3. Worker receives the turn prompt with prior context, executes tool calls locally, and streams back `message_update` and `tool_execution_*` events.
4. Server transforms stream events into live-updating Feishu card components.
5. In-flight messages support **Steering** (`agent.steer()`) when new user prompts arrive while tools are executing.

#### Mode B: Asynchronous Ticket Pipeline (Decoupled Background Tasks)
1. When a task requires substantial multi-step modifications (e.g., "Refactor module X and submit a PR") or originates from Cron/Webhooks, it is formalized as a **Ticket**.
2. The Server or Main Assistant creates a structured Ticket (`title`, `objective`, `repo`, `tags`, `contextSummary`).
3. Workers matching the required tags pull or are assigned tickets.
4. Worker executes the ticket inside an isolated, fresh session workspace and reports progress markers (e.g., branch pushed, PR opened).
5. Chat threads receive progress updates and link back to the resulting GitHub/GitLab artifacts.

### 2.4 Worker Concurrency & Slot Management

Each worker declares a capacity specification:
- **Slot Count**: The maximum concurrent agent tasks a worker can execute simultaneously.
- **Hardware Profile**: Reported CPU, memory, and OS architecture in regular heartbeats.
- **Directory Isolation**:
  - For `slot = 1` (typical developer laptop): Execution runs in the primary checked-out workspace or a single task branch.
  - For `slot > 1`: The worker automatically provisions dedicated **`git worktree`** directories (e.g., `.worktrees/session-<uuid>`) to prevent file collisions and git state thrashing between concurrent sessions.

### 2.5 Storage & Single Source of Truth (SST)

Worker nodes (especially developer laptops) must be treated as transient, disposable compute targets:
- **Server Owns**:
  - Space definitions, chat associations, and worker authentication tokens.
  - Space long-term memory (structured summaries, architectural rules).
  - Authoritative session message history (`AgentMessage[]`).
  - Active ticket queues and worker routing tables.
- **Worker Owns**:
  - Local disk Git repositories, branch worktrees, and build artifact caches (e.g. `node_modules`).
  - Active task memory structures during execution.

---

## 3. Code Reuse from Pi Framework

MEEPO directly leverages production-grade subsystems from `@earendil-works/pi`:

| Pi Monorepo Component | MEEPO Integration | Benefit |
|---|---|---|
| **`@earendil-works/pi-ai`** | Model invocation in Worker & Server | Unified API for OpenAI, Anthropic, Gemini, DeepSeek; stream parsing; tool call argument deltas; reasoning/thinking block extraction. |
| **`@earendil-works/pi-agent-core`** | Agent Loop in `meepo-worker` | Stateful execution loops, `beforeToolCall`/`afterToolCall` lifecycle hooks, steering/follow-up message queues, and context transformers. |
| **`coding-agent/src/core/tools/`** | Pluggable tool operations | Direct reuse of `createReadTool`, `createWriteTool`, `createEditTool`, and `createBashTool` via pluggable `Operations` interfaces (`ReadOperations`, `BashOperations`, etc.). |
| **`coding-agent/src/core/compaction/`** | Context compaction | File operation extraction, lossy conversation summarization, and token preservation for long multi-turn sessions. |

---

## 4. Work Breakdown & Phased Roadmap

- **Phase 1: Foundation & Monorepo Scaffolding**
  - Establish Moon + pnpm workspace structure (`apps/*`, `packages/*`).
  - Define wire protocol contracts (`@meepo/protocol`) and domain models (`@meepo/core`).
  - Define evergreen specification documentation (`specs/`).
- **Phase 2: Core Server & Worker Communication**
  - Implement `meepo-server` connection hub (WebSocket RPC).
  - Implement `meepo-worker` registration, heartbeat, and capacity slot reporting.
  - Implement bidirectional task dispatch and streaming event relay.
- **Phase 3: Pi Agent Runtime Integration & Worktree Isolation**
  - Wire `@earendil-works/pi-agent-core` into `meepo-worker`.
  - Implement `git worktree` allocation and cleanup for multi-slot workers.
  - Implement streaming event transformation into rich execution updates.
- **Phase 4: Feishu IM Integration**
  - Implement Feishu webhook ingestion, message deduplication, and card streaming renderer.
  - Support space-to-chat bindings and thread session routing.
- **Phase 5: Long-term Memory & Ticket Pipeline**
  - Implement space memory extraction and automated compaction summaries.
  - Implement ticket creation, claiming, and asynchronous PR workflow.
- **Phase 6: Management Console**
  - Web console for space administration, worker topology, and live slot monitoring.
