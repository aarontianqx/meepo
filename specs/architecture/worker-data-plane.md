# Worker Data Plane Architecture

The `meepo-worker` is a self-hosted runner daemon executing on developer machines, on-prem servers, or cloud sandboxes. It is stateless across **ticket** lifetimes, but **sticky for sessions**: a session's agent process and workspace live on its bound worker for the session's whole lifetime.

## Core Modules

### 1. Registration & Heartbeat

- Establishes a persistent outbound connection to `meepo-server` via WebSocket.
- Authenticates with an enrollment token issued by any space member; the token alone determines which spaces the worker may serve.
- Generates its `workerId` at first boot and persists it in the data directory; the token binds to that `workerId` on first use and later mismatches are rejected — bindings and queued dispatches are restored against it on reconnect.
- Emits periodic heartbeats (15s) including active slot utilization and current run IDs (CPU/memory metrics are optional wire fields) (`activeRunIds`); each heartbeat renews the execution lease of the runs it carries in `activeRunIds` (lease = 3 heartbeat intervals — 45s at the default 15s — server clock authoritative). On connection loss the worker starts no new runs and aborts local work after the disconnected lease window; on reconnect it reconciles runs with the server and kills any the server has invalidated.

### 2. Working Directories

- Owns the physical state of executions: per-task working directories and their contents. This local state is what makes session affinity a hard constraint, and it is never migrated implicitly.
- **Meepo manages no repositories**: sessions and tickets both start in a neutral per-task directory (`~/.meepo/sessions/<session-id>`, `~/.meepo/tickets/<ticketId>/attempt-N` — a fresh directory per ticket attempt, old attempts kept for audit). Whether a task involves a repo is a prompt-level concern — the agent clones or worktrees repositories itself. (The worktree-before-modifying-code rule lives in the optional _coding preset_, not in the universal base prompt.)
- Repository credentials belong to the worker's own environment (the machine owner's git/SSH configuration); neither plane ever handles repo auth.
- Inactive task directories are eligible for reclamation after 7 days; active runners and pending creates are protected, and a `session.closed` notification aborts work and reclaims local resources after execution actually settles; normal worker shutdown preserves directories. An explicit rebind releases the old main-session directory only after active work stops.

### 3. Agent Execution Engine

- Embeds `@earendil-works/pi-agent-core`'s `Agent` loop; model credentials resolve from the server's model registry (space references a `modelId`) and are injected per dispatch (TLS on the worker channel is a prerequisite for real credentials).
- Sessions stay warm: the agent process may outlive a turn. After TTL eviction or a worker restart, the session cold-starts from the server-provided snapshot.
- **System prompt = universal skeleton + optional domain presets**: identity/runtime (bot name, time, workdir) + space memory index + skills (`~/.agents/skills/` descriptions) + channel info. Domain presets (e.g. the coding preset with worktree discipline) are opt-in per space, never hardcoded into the base. The rendered prompt is recorded at the first cold execution so resumes don't drift — the freeze covers identity and presets; tool descriptions remain stable while warm and are refreshed with local rules and skills on cold start; the directory-level Memory Map is a separately versioned suffix block, re-rendered at cold starts (first execution of a new session, restart, TTL eviction, `/new`) and recorded with each snapshot.
- Effective timing is split three ways: identity/presets are frozen for the session's lifetime; tool descriptions and local rules refresh only at cold starts; memory bodies are retrieved live via tools, with only the directory map injected; the wall-clock time is frozen in the prompt snapshot while the current time rides in each turn's envelope (machine turns' origin envelopes included) — the prompt stays cache-stable without the agent losing track of elapsed time.
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
- Media normalization is worker-side: images referenced in the transcript are downloaded through the server’s resource-authorized `media.read` proxy, cached in the shared `<sessionsDir>/.media` directory, and downscaled only on the model-bound copy.

### 4. Delivery, Steering & Wakeup

- All current producers use `wait`. The protocol also reserves the other delivery semantics: `urgent` (end the active turn — run `interrupted` — and start a new one), `wait` (queue behind it), `if_idle` (drop when busy, leaving a `dropped` run record). Consecutive queued messages may merge into a single turn; runs pre-created for messages later merged are closed as `merged`.
- Handles `turn.dispatch` envelopes (user turns and schedule fires): cold-starts the session from the server snapshot if needed, then runs a turn in the restored context.
- Listens for server-initiated `abort` signals and cancels running tool child processes.

### 5. Server-Backed Tools

- Scheduling tools (`CronCreate` / `CronList` / `CronDelete` for session wakeups, `TicketCreate` for independent tasks) proxy to the server; schedule records live server-side. The worker holds no timers or scheduler of its own.
- **Memory tools** (`MemoryList` / `MemorySearch` / `MemoryRead` / `MemoryWrite` / `MemoryDelete`) proxy to the server; the system prompt carries a directory-level Memory Map snapshot (refreshed on cold starts, possibly stale while warm — tools always return current data), and writes are guarded by `expected_revision` optimistic locking.
- Transcript snapshots are fetched by the runtime over RPC during cold restoration; there is no separate agent-facing history-query tool. Memory tools always query current server data.

### 6. Configuration Lifecycle

The owner configures TOML or JSON (`MEEPO_WORKER_CONFIG`, default `~/.meepo/worker.toml`). Environment overrides take precedence. File changes atomically publish MCP connections and model defaults for subsequent tickets/cold sessions; failed validation or connection retains the entire previous generation. Warm sessions retain their current tools/model, and old MCP connections close after their final session lease releases. Connection settings, paths, identity, tags, TTL and slot capacity require restart. Space thinking-level selection overrides the worker default. Shutdown aborts active runs, flushes terminal events when connected, closes MCP and WebSocket connections, and preserves workspace files.

Agent-originated server tools include their current `runId`. The server checks ownership, resource association and an unexpired running lease before memory access or schedule/ticket mutations, fencing obsolete attempts independently of client behavior.

### Media retention

Downloaded originals live in `<sessionsDir>/.media`, keyed by channel namespace/message/file identity and excluded from task-directory reclamation. Closing a session or reclaiming its working directory does not delete those originals. A new worker can fetch the referenced source through the server proxy; caches remain local to each worker. An operator retiring a worker must retain its media cache when historical source availability matters.

### Model selection and reasoning effort

The space selects a server model-registry entry. The agent stream uses `openai-completions`; a provider name identifies the configured endpoint and does not select a different wire API. Effective `thinkingLevel` is **space override → worker model default → model capability default**. New spaces/workers need not set it. Kimi entries in the current capability table (including K3) default to `max`; its named GPT entries default to `high`. Unknown model IDs currently fall back to K3 capabilities, so arbitrary model compatibility is not guaranteed.

Ordinary agent requests explicitly send `reasoningEffort`. A warm session retains the model/effort used to create its runner; a fresh ticket or cold session resolves current configuration. Compaction uses a separate summary-provider path and now forwards the configured thinking level. Compaction starts around 80% of the configured context window, retains a recent tail with intact tool pairs, and leaves the server event log unchanged; summary failure falls back to bounded recent history.

### Durable history and output budgets

Cold recovery reads 50-event pages. Above 256 KiB of buffered canonical history, it summarizes an old prefix and retains at least 40 recent relevant events, moving the split backward to keep tool call/result pairs together. Each prefix cache is recorded server-side with `coversThroughSeq`; later cold starts resume from the compatible cached prefix and original tail. Until a complete tool pair is available, recovery waits to compact that prefix; an orphan at the end remains explicitly unknown. History size is counted incrementally on append/removal. The 256 KiB threshold triggers compaction; it is not a hard memory limit. The accumulated relevant-event buffer is capped at 4 MiB of serialized history or 4,096 events. Exceeding either cap fails recovery explicitly (including when an unresolved tool prevents a safe split), without deleting raw history or inventing tool outcomes. The error directs users to inspect the Console and open a new session. These limits bound the accumulated buffer, not total process memory or the page already fetched. The first recovery of uncached historical data may still need multiple summary requests.

Warm runners retain their local summary/tail and use token-threshold compaction. Canonical prefix caches are built during cold recovery rather than assigning invented event sequence numbers to warm Pi messages. A warm summary is not itself a canonical transcript entry. Both paths summarize in bounded chunks (≤32,000 input bytes per chunk, reduced further for a small model context), carry a bounded preceding summary and retain original server history. Failure records an explicit truncation note visible in the Console and model context; the warm fallback also applies a token budget, including an oversized single-message/tool-group escape hatch.

All tool adapters bound returned output before it reaches model history. Oversize output is saved with mode `0600` under `<taskDir>/.tool-output/`, and the model/server see a bounded preview plus local path. These artifacts follow task-directory retention and are not downloadable from the server; bash's own full-output temporary file remains governed by its tool implementation.
