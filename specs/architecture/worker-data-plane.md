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

- **Sessions** keep their in-memory runner warm across turns until idle past `sessionTtlMs` (default `1 hour`; a session with a dispatch still being prepared is never evicted), closed, or restarted. Warm sessions retain their initial model configuration (endpoint, API key and capabilities, including image input) and MCP tool generation for stability; cold starts re-fetch canonical history via `session.snapshot` and re-render the system prompt.
- **Tickets** instantiate a single-turn runner per dispatch and tear it down immediately upon completion.

### Built-In Local Tools

Every session and ticket provides four local workspace tools rooted at the task's working directory:

1. **`read`**: Reads local text/image files from the worker filesystem.
2. **`write`**: Creates or overwrites local files (creating parent directories as needed).
3. **`edit`**: Applies exact string-replacement edits with diff feedback.
4. **`bash`**: Executes shell commands in a child process with streaming output and abort propagation (`SIGTERM`/process tree cancellation on `run.abort`). Subprocesses inherit the worker's environment **except** `MEEPO_*` variables (enrollment token, server URL, data paths); on ticket runs, subprocesses receive `MEEPO_IDEMPOTENCY_KEY=<ticketId>-<attempt>`. When the session (or ticket) has a frozen timezone from `prompt.prepare`, subprocesses also get `TZ=<timezone>`; without one they keep the worker host's zone.
   _Rationale: Any participant in a bound chat can ask the agent to inspect environment variables; stripping `MEEPO_*` keeps worker enrollment credentials unreachable from tool subprocesses. `TZ` makes `date`, logs and commit timestamps agree with the clock the agent is shown instead of the host's, without touching the worker process or other sessions._

### Tool Output Bounding

Every local, server-backed, and MCP tool is wrapped by an output budget guard before results enter model context or wire events:

- Payloads up to `64 KiB` UTF-8 pass through intact.
- Results or thrown errors exceeding `64 KiB` write their full serialized JSON to `<taskDir>/.tool-output/<uuid>.json` (`0600`) and return an `8,000`-byte head/tail preview plus the local artifact path to the model and execution journal. `.tool-output/` follows its parent task directory's 7-day lifecycle and is not downloadable from the server.

### Project Instructions (lazy `AGENTS.md` discovery)

A worker has no launch directory, so a project's `AGENTS.md` cannot be loaded at startup; the project only appears once the agent works in it. Sessions and tickets share one tool wrapper (outside the output-budget guard) that discovers instructions on first touch and appends them to that tool result as an extra text block. The system prompt and its prefix cache never change.

- **What counts as a touch**: the `path` of `read`, `write`, `edit`, `grep`, `find`, `ls` (relative paths resolve against the task directory), and for `bash` the absolute, `./`, `../` and `~/` paths in the command plus `cd` targets. The path must exist; shell commands consider at most 20 distinct paths.
- **Boundary**: the nearest ancestor containing `.git` (a file or directory) is the project root. Without one, only paths inside the task directory count and the task directory is the root. Nothing outside the root, and no `AGENTS.md` above it, is read. Only the exact file name `AGENTS.md` is recognized.
- **What is appended**: `AGENTS.md` of every directory from the root down to the touched directory, root first, each as `[Project instructions: <file> (project <root>, sha256:<12 hex>) — applies to files under <dir>]` followed by the content. A file is cut at `16 KiB` with `[truncated; read <file> for the rest]`.
- **Deduplication**: a file is not sent again while its content digest matches what the conversation already contains; an edited file is sent again with its new digest. If appending would push the whole tool result past the `64 KiB` journal bound, the instructions are left for the next touch instead of being truncated.
- **Restore**: on a cold start the worker rebuilds what the conversation contains by scanning restored tool results for the marker line, so nothing is persisted on the worker. Projects touched before the latest compaction cache and not touched since are sent again on their next touch.
- **Failure**: discovery never fails a tool call; errors are logged and the result is returned unchanged.

_Rationale: appending to the conversation tail keeps the cached prefix intact and lets the agent that starts in project A and moves to project B pick up each project's conventions where it first uses them. The `.git` boundary stands in for the launch directory that a general agent lacks._

### Server-Backed Tools

- **Memory tools** (`MemoryList`, `MemorySearch`, `MemoryRead`, `MemoryWrite`, `MemoryDelete`): Available identically in both sessions and tickets; proxy over `memory.call` RPC with the active `runId` so the server enforces lease validity and space ownership.
- **Orchestration tools** (`CronCreate`, `CronList`, `CronDelete`, `TicketCreate`): Provided **only to interactive sessions** — tickets have no conversational session to wake up and cannot recursively spawn tickets or schedules.

### MCP Tool Lifecycle and Hot Reload

Worker owners configure external MCP servers in `worker.toml` / `.json` under `[mcp.<server>]` using either `command` + `args` + `env` (stdio) or `url` + `headers` (Streamable HTTP):

- Server names must match `[a-zA-Z0-9_-]+`; discovered tools are exposed as `mcp__<server>__<normalizedToolName>` (colliding normalized names fail reload). Stdio servers inherit the worker host environment with `MEEPO_*` variables stripped, overlaid with any explicit `[mcp.<server>.env]` entries. Connection timeout defaults to `30s`; call timeout defaults to `timeoutSeconds ?? 60s` and propagates run `AbortSignal`. On ticket runs, `callTool` attaches `_meta: { meepoIdempotencyKey: "<ticketId>-<attempt>" }`.
- **Reference-counted generations**: Watching `worker.toml` (2-second poll) reloads `mcp` and `modelDefaults` atomically. If any MCP server fails validation or connection, the new generation closes and the previous generation remains active. Newly started tickets and cold-started sessions acquire a lease on the latest generation; warm sessions hold their existing generation lease until evicted or closed, after which zero-reference old generations close their connections cleanly.

## 4. Model Resolution and Context Compaction

### Model selection and reasoning effort

Spaces reference a `modelId` from the server's `ModelRegistry`, injected per dispatch alongside its endpoint, API key and capabilities (`contextWindow`, `maxTokens`, `reasoningEfforts`, `defaultEffort`, `imageInput`). Model calls use the OpenAI Chat Completions streaming wire protocol (`supportsDeveloperRole: false`), with `reasoningEffort` passed explicitly on every turn of a reasoning model (none is sent for a model whose `reasoningEfforts` is empty); compaction summary calls request reasoning only when a supported level was chosen. Effective effort resolves by precedence:

```text
Space model.thinkingLevel  ──►  Worker modelDefaults.thinkingLevel / MEEPO_THINKING_LEVEL  ──►  Entry defaultEffort
```

A requested level the model does not list in `reasoningEfforts` is ignored and the entry's `defaultEffort` applies.

The worker holds no capability table: window, output limit and reasoning support are exactly what the dispatched entry declares (the server fills them in when the entry is created). Image input is likewise exactly the entry's `imageInput`: when it is `false`, attached images are replaced by a short note instead of being sent.

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
