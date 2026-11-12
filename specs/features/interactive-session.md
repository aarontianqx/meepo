# Feature: Interactive Streaming Session

> **Scope**: Defines real-time conversational sessions — window addressing, `main` vs. `thread` session lifecycles, inbound routing gates, supported media modalities, queued turn merging, delivery/interruption semantics, `/new` and rebind state transitions, and live streaming card behavior.

## 1. Windows and Session Kinds

An IM **window** is addressed as `windowId = {channelId}:{chatId}:{subId}`. At most one non-`closed` `Session` exists per window (`unique (spaceId, channelId, chatId, threadId) WHERE status != 'closed'`), persisted server-side across restarts:

- **Private chat (`p2p`)**: `subId = senderOpenId`, `kind = 'main'`. One long-lived main session per user under that channel; replies always stay in the direct chat stream (no threads). Supports `/new` to reset and auto-compacts when long.
- **Group main stream (`group`, `subId = '_group'`)**: `kind = 'main'`. Long-lived conversation in the group's main timeline. Answering a **reply** message in the main stream that `@mentions` the bot continues this `main` session directly without spawning a thread. Supports `@bot /new`.
- **Group thread (`group`, `subId = threadId`)**: `kind = 'thread'`. Dedicated per-topic session for focused multi-turn tasks (such as debugging or code changes).
  - A fresh `@bot` message in the group main stream (not a reply) sends a temporary prewarm reply (`正在处理，请稍候…`) with `replyInThread: true` to establish a new thread and opens a `thread` session anchored to that root message.
  - Mentioning `@bot` mid-way inside an existing unengaged thread opens a `thread` session and seeds its transcript with up to **50** prior messages from that thread (`seedThreadHistory`) so the agent has surrounding context.
  - Once a thread has an engaged session, subsequent replies in that thread route to it **without** requiring `@bot` (unless they explicitly `@mention` only other users/bots). `/new` is rejected inside threads (`话题内不支持 /new（话题过长时会自动压缩）。`); threads rely on automatic context compaction instead.

_Note on `kind = 'main'`_: `main` denotes a window's lifecycle and migration behavior (private or group main stream), not a single space-wide orchestration inbox.

## 2. Inbound Decision Chain

Every normalized inbound IM event passes four sequential gates:

1. **Durable deduplication**: Ignore non-user senders and message IDs already recorded in `ProcessedMessages` for `channelId` (committed atomically with work creation, retained 7 days).
2. **Channel & space admission**: Resolve `spaceId` from `channelId` (`p2p` checks `allowedOpenIds`; `group` requires `chatId ∈ channel.boundChatIds`). Unadmitted events stay silent.
3. **Command & respond gate**:
   - Intercept `/new` (`p2p` directly, `group` when `@bot` is mentioned): execute session reset on `main` windows or reply with rejection inside threads.
   - `p2p`: always respond.
   - `group`: ignore messages that `@mention` other principals while omitting `@bot`. Inside an engaged thread, respond to any message; inside an unengaged thread or main stream, require `@bot`.
4. **Session binding & placement**:
   - Reuse the window's active session if present (coalescing concurrent session-creation races onto the same session).
   - On creation: `main` sessions bind to `space.boundWorkerId`; `thread` sessions pick a random online, enrolled, tag-matched worker and remain pinned to it permanently.

### Supported Input Modalities

Inbound messages accept **text**, **quoted parent messages**, and **images**:

- **Quoted messages**: When a message replies to `parentId` in the same chat, the gateway fetches the parent message and prepends `<quoted_message>{"sender":"...","body":"..."}</quoted_message>` (`≤ 12,000` chars).
- **Images**: Image messages normalize to `[Image]` plus `ImageReference { messageId, fileKey }`. Neither raw bytes nor channel secrets are stored in transcripts or sent in dispatch envelopes; the bound worker downloads bytes on demand via the server's `media.read` RPC (`≤ 10 MiB`), caches originals in `<sessionsDir>/.media`, and passes a downscaled JPEG to the model. Download errors or oversized files degrade to `[图片下载失败]`; models without vision support receive `[图片：当前模型不支持图像输入]`. Arbitrary file attachments and rich-text card inputs are currently ignored.

## 3. Turn Batching, Delivery Modes, and Interruption

### Queued Turn Merging

When users send multiple messages while a session is busy or its bound worker is offline, consecutive `wait` inputs merge into one turn rather than generating fragmented back-to-back replies:

- **Offline server-side merge (`TxMergeQueue`)**: Coalesces never-dispatched `queued` turns on flush. The earliest pre-created `Run` survives as `dispatched` (inheriting all `initiatorIds` and `mergedSourceIds`), while absorbed runs close as `merged` (`mergedIntoRunId` pointing to the surviving run).
- **Warm worker-side merge**: Turns arriving while a `SessionRunner` is executing queue locally and merge when the active turn finishes, emitting `run_merged` for absorbed runs.

### Delivery Modes

| Mode      | Behavior                                                                                           | Current Producers                                                         |
| --------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `wait`    | Queue behind active execution; consecutive `wait` turns merge.                                     | All active sources: IM messages, HTTP turns, mailbox, receipts, schedules |
| `urgent`  | Abort active run immediately (`failed(interrupted)`) and start a new turn ahead of queued `wait`s. | Protocol-reserved (`400` on HTTP `/turns`)                                |
| `if_idle` | Execute if idle; drop immediately as `dropped` if the session is busy.                             | Protocol-reserved (`400` on HTTP `/turns`)                                |

### Space Rebind and `/new` Transitions

Both explicit space rebinding (`POST /api/spaces/:id/binding`) and `/new` are **always permitted**, regardless of whether the target `main` session is idle, running, or pinned to an offline worker:

| Session State      | Space Rebind (`main` sessions only; `thread`s stay untouched)                                                                  | `/new` (`main` windows only; rejected in `thread`s)                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Idle**           | Updates `boundWorkerId`, moves queued turns, sends `session.closed` to old worker, appends migration `system_note`.            | Closes old session (transcript retained), cascade-deletes `resume_session` schedules, opens fresh session, queues confirmation text. |
| **Running**        | Marks active run `failed(interrupted)`, sends `run.abort` + `session.closed`, closes streaming card, then applies Idle path.   | Marks active run `failed(interrupted)`, sends `run.abort` + `session.closed`, closes streaming card, then applies Idle path.         |
| **Worker offline** | Fences dead run as `failed(interrupted)` in storage immediately and migrates session + queued turns without waiting for lease. | Fences non-terminal runs in storage immediately, closes old session, cancels schedules, and opens fresh session.                     |

_Rationale: Rebinding is most urgently needed when a developer laptop goes offline; refusing rebind while a run is active or offline would trap main chat windows behind expired leases, whereas leaving `thread` sessions pinned protects uncommitted task files on the original machine._

## 4. Outbound Streaming Projection

### Generic Streaming Semantics

- **Content-gated card creation**: A run opens an outbound card only once visible assistant text or thinking arrives (or when a user-initiated run fails). Tool calls alone never open a placeholder card, and proactive machine turns (schedule wakeups, ticket receipts) that complete silently or fail produce **no card at all**.
- **Card anatomy**:
  1. Collapsible thinking panel (`💭 思考中` while streaming, `思考过程` once settled; retains latest `6,000` chars of reasoning).
  2. Tool status pills (`⏳` running, `✓` completed, `⚠️` failed + backticked tool name; latest `10` tools; never arguments or results).
  3. Markdown answer body (`30,000`-character pagination — overflowing streams finalize the current card with `↓ 内容较长，后续见下一张卡片` and open a continuation card).
  4. `停止` danger button (`action: 'abort_run'`, `runId`), shown **only** while streaming and authorized exclusively for `Run.initiatorIds` (Console members may also abort via `/api/sessions/:id/runs/:runId/abort`).
- **Localized failure notices**: User-visible failures translate internal `terminalReason` codes into clear Chinese explanations (for example, `lease_lost` renders `Worker 连接中断，本次执行已终止。已发生的外部操作可能仍需核实。`, `worker_lost` renders `Worker 连接中断，本次执行无法继续。`, `interrupted` renders `本次执行已中断。`, `cancelled` renders `任务已取消。`).

### Feishu Adapter Mechanics

- Cards use CardKit `schema: '2.0'` with `streaming_mode: true` during generation, patched serially per run at ~`500 ms` intervals with monotonically persisted `sequence` numbers, and explicitly close `streaming_mode: false` on settlement.
- Thread session replies attach to `session.anchorMessageId` (the thread's root message) with `replyInThread: true`, deleting `prewarmMessageId` once the first card reply lands; `main` sessions reply with `replyInThread: false`.
