# Worker Data Plane Architecture

> **Scope**: Specifies the self-hosted `meepo-worker` execution daemon — registration and lease discipline, isolated working directories and media caches, built-in local and server-backed tools, MCP server hot-reloading, model resolution, and context compaction budgets. Wire framing lives in [Worker Protocol](worker-protocol.md); prompt text layout lives in [Prompt and Context Assembly](../features/prompt-and-context.md).

## 1. Registration, Identity, and Execution Leases

- **Stable local identity**: At first boot, the worker generates a UUID `workerId` and writes it with mode `0600` to `<dataDir>/worker-id` (honoring `MEEPO_WORKER_ID` on initial creation and rejecting subsequent mismatches). Preserving this file across restarts allows the server to restore session affinity and queued dispatches.
- **Outbound enrollment**: Connects outbound to `serverUrl` (`/ws/worker`) using its `enrollmentToken`, which binds 1:1 to `workerId` on first registration and defines the exact `spaceIds` the worker may serve.
- **Heartbeats and lease discipline**: Emits heartbeats at the server-advertised interval (default `15s`) carrying `activeSlots` and all owned `activeRunIds`. Each heartbeat extends the server lease of listed valid runs by `3 × heartbeatIntervalSeconds` (`45s` default, measured by the server clock).
  - Before every model request and after every non-delta agent step, the runner awaits `beforeExecution(runId)`, verifying that the WebSocket is registered/reconciled, buffered events for `runId` are flushed and ACKed, and `runId` has not been invalidated.
  - On disconnect, no new model or tool step begins; an already-running local subprocess may finish while events buffer in memory, but if the connection remains down past the local lease window (`45s`), the worker aborts all owned runs (`lease_lost`). On reconnect, `run.reconcile` aborts any run invalidated server-side before replaying buffered events and signaling `worker.ready`.

## 2. Working Directories and Media Cache

- **Per-task directory isolation**: Concurrent tasks never share a working directory:
  - Interactive sessions execute in `<sessionsDir>/<sessionId>`, preserved across turns and ordinary worker restarts so session-local state stays intact.
  - Ticket attempts execute in `<ticketsDir>/<ticketId>/attempt-<N>` (`N = 1..3`), giving every retry a clean workspace while retaining prior attempt directories for local inspection.
- **Repository neutrality**: Meepo never clones repositories or manages git credentials on behalf of tasks. Repository URLs on a space are optional prompt hints; cloning, branching, or creating a `git worktree` (required by the opt-in `coding` preset) is performed by the agent using the worker host's ambient SSH/git environment.
- **Directory reclamation**: A background sweep reclaims inactive task directories whose `mtime` exceeds **7 days** (never following symlinks), while protecting active runners, in-flight cold starts, and `<sessionsDir>/.media`. When `session.closed` arrives (from session close, `/new`, or `main`-session rebind), the worker aborts active runs on that session, waits for tool execution to settle, releases MCP leases, and deletes `<sessionsDir>/<sessionId>`. Graceful worker shutdown (`SIGTERM`/`SIGINT`) aborts active runs, flushes buffered terminal events, and **preserves** task directories on disk.

### Media retention

Images referenced in session turns (`ImageReference { messageId, fileKey }`) are fetched through the server's authorized `media.read` RPC (capped at `10 MiB` binary / `14 MiB` base64), saved with mode `0600` under the shared `<sessionsDir>/.media/<sha256(namespace:messageId:fileKey)>` cache, and excluded from the 7-day task-directory sweep. Only a downscaled JPEG copy (`≤ 2048×2048`, rotated per EXIF, quality `85`, `≤ 40` megapixels input) is passed as base64 `ImageContent` to the model, accompanied by `[Image original: <local-path>]` so local tools can inspect the untouched file if needed. Because `.media` is local to each worker, retiring a host requires preserving `<sessionsDir>/.media` if historical source images are no longer downloadable from the IM provider.

## 3. Agent Loop, Tools, and Output Budgets

### Concurrency Semaphore

A single worker-wide `SlotSemaphore(maxSlots)` (`1–128`, default `1`) gates both `SessionRunner` turns and `TicketRunner` attempts. Queued slot waiters are cancellable via `AbortSignal` (so cancelling a queued turn or ticket frees it immediately without waiting for a slot), and slot releases wake waiting interactive `session` turns strictly ahead of `ticket` attempts.

### Warm vs. Cold Runners

- **Sessions** keep their in-memory runner warm across turns until idle past `sessionTtlMs` (default `1 hour`), closed, or restarted. Warm sessions retain their initial model configuration and MCP tool generation for stability; cold starts re-fetch canonical history via `session.snapshot` and re-render the system prompt.
- **Tickets** instantiate a single-turn runner per dispatch and tear it down immediately upon completion.

### Built-In Local Tools

Every session and ticket provides four local workspace tools rooted at the task's working directory:

1. **`read`**: Reads local text/image files from the worker filesystem.
2. **`write`**: Creates or overwrites local files (creating parent directories as needed).
3. **`edit`**: Applies exact string-replacement edits with diff feedback.
4. **`bash`**: Executes shell commands in a child process with streaming output and abort propagation (`SIGTERM`/process tree cancellation on `run.abort`). On ticket runs, subprocesses receive `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>` in their environment.

### Tool Output Bounding

Every local, server-backed, and MCP tool is wrapped by an output budget guard before results enter model context or wire events:

- Payloads up to `64 KiB` UTF-8 pass through intact.
- Results or thrown errors exceeding `64 KiB` write their full serialized JSON to `<taskDir>/.tool-output/<uuid>.json` (`0600`) and return an `8,000`-byte head/tail preview plus the local artifact path to the model and execution journal. `.tool-output/` follows its parent task directory's 7-day lifecycle and is not downloadable from the server.

### Server-Backed Tools

- **Memory tools** (`MemoryList`, `MemorySearch`, `MemoryRead`, `MemoryWrite`, `MemoryDelete`): Available identically in both sessions and tickets; proxy over `memory.call` RPC with the active `runId` so the server enforces lease validity and space ownership.
- **Orchestration tools** (`CronCreate`, `CronList`, `CronDelete`, `TicketCreate`): Provided **only to interactive sessions** — tickets have no conversational session to wake up and cannot recursively spawn tickets or schedules.

### MCP Tool Lifecycle and Hot Reload

Worker owners configure external MCP servers in `worker.toml` / `.json` under `[mcp.<server>]` using either `command` + `args` + `env` (stdio) or `url` + `headers` (Streamable HTTP):

- Server names must match `[a-zA-Z0-9_-]+`; discovered tools are exposed as `mcp__<server>__<normalizedToolName>` (colliding normalized names fail reload). Connection timeout defaults to `30s`; call timeout defaults to `timeoutSeconds ?? 60s` and propagates run `AbortSignal`. On ticket runs, `callTool` attaches `_meta: { meepoIdempotencyKey: "<ticketId>-<attempt>" }`.
- **Reference-counted generations**: Watching `worker.toml` (2-second poll) reloads `mcp` and `modelDefaults` atomically. If any MCP server fails validation or connection, the new generation closes and the previous generation remains active. Newly started tickets and cold-started sessions acquire a lease on the latest generation; warm sessions hold their existing generation lease until evicted or closed, after which zero-reference old generations close their connections cleanly.

## 4. Model Resolution and Context Compaction

### Model selection and reasoning effort

Spaces reference a `modelId` from the server's `ModelRegistry`, injected per dispatch alongside its endpoint and API key. Model calls use the OpenAI Chat Completions streaming wire protocol (`supportsDeveloperRole: false`), with `reasoningEffort` passed explicitly on every turn and compaction summary call. Effective effort resolves by precedence:

```text
Space model.thinkingLevel  ──►  Worker modelDefaults.thinkingLevel / MEEPO_THINKING_LEVEL  ──►  Model capability default
```

Known Kimi K2.8/K3 models default to `'max'` (`1,048,576` context window, `128,000` max output tokens; multimodal image input enabled by default for `kimi-k*` unless overridden by `ModelEntry.imageInput`); named GPT-5.6 entries default to `'high'` (`1,050,000` window). Unrecognized model IDs currently fall back to the K3 capability profile.

### Two-Tier History Compaction

Raw canonical events on the server are never deleted or overwritten; workers bound context size through two complementary paths that never split `tool_call` / `tool_result` pairs:

1. **Cold-start canonical prefix compaction (`loadDurableHistory`)**:
   - Reads `session.snapshot` in `50`-event pages starting from the latest non-degraded server `CompactionCache` (if any).
   - Tracks serialized byte size incrementally (omitting base64 image payloads from summary text). Once buffered relevant events exceed **`256 KiB`**, it selects a prefix leaving at least **40** recent events, shifting the cut earlier as needed so no `tool_call` is separated from its `tool_result` (and waiting for the next page if an open call might close later).
   - Summarizes in chunks (`≤ min(32,000 bytes, contextWindow / 4)` per call, bounded to `16,000` bytes output) and records `{ coversThroughSeq, summary, degraded }` via `session.compaction`.
   - **Degradation propagation**: If summarization fails, it falls back to a bounded `8,000`-byte excerpt prefixed with a Chinese truncation warning and marks `degraded = true`; every subsequent summary chained onto a degraded excerpt inherits `degraded = true` until a later cold start re-summarizes from raw events.
   - **Hard safety ceiling**: If accumulated uncompacted events exceed **`4 MiB`** or **`4,096` events** (for example, an unresolved tool group preventing a safe split), cold recovery aborts explicitly without inventing tool outcomes or dropping history, instructing the user to inspect the Console and start a new session.
2. **Warm in-memory compaction (`SessionCompactor`)**:
   - Before each turn on a warm runner, estimates context tokens and triggers compaction above **80%** of `contextWindow`, retaining approximately the most recent **20%** of tokens with intact tool pairs.
   - Warm summaries stay in runner memory rather than inventing canonical `seq` boundaries. If summarization fails on a warm runner, it emits a durable `context_note` (`system_note` in Console) and falls back to recent messages within the token budget (or a bounded `16,000`-byte excerpt if a single message/tool group exceeds the budget).
