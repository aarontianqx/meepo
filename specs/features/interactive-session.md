# Feature: Interactive Streaming Session

## 1. Overview

Interactive Sessions provide real-time, bidirectional communication between Feishu users and a MEEPO worker executing tasks in the context of an ongoing thread.

## 2. Windows and Sessions

A **window** is the IM address a session is bound to: `window_id = {channelId}:{chat_id}:{sub_id}`. One window maps to at most one active session; the window→session mapping is persisted so it survives server restarts.

**Private chat** — one main session per user (`sub_id = sender open_id`), no threads anywhere: the bot always replies in the main flow. The session auto-compacts when it grows long; `/new` closes it and starts a fresh one.

**Group chat** — two session shapes coexist:

- **Thread sessions** (`sub_id = thread_id`, kind `thread`): one per thread, used for focused coding work. When the bot is first mentioned midway through a thread, the new session is seeded with the thread's existing history so it has the full context.
- **The group's main session** (`sub_id = _group`, kind `main`): the long-lived conversation of the main stream. A **reply** that involves the bot (a reply mentioning it) continues this session and is answered in the main flow — it never spawns a thread.

Routing inside the group main stream: a fresh `@bot` mention (not a reply) prewarms a **new thread** and a new thread session; a reply mentioning the bot goes to the group main session.

**`/new` rotates a main session** (private chat or group main flow): it closes the current session (transcript retained server-side) and opens a fresh one. It is rejected inside threads — threads auto-compact instead.

A space designates one window as its **main window** — carrier-agnostic: the owner's private chat or a designated group — whose session acts as the space's orchestration entry. The main window is a routing concept only; it carries no special execution mechanism.

On a user-initiated space rebind, every chat session (private, group-main, main-window) follows to the new worker: the transcript is preserved server-side, the local working directory is abandoned, and a migration notice (`system_note`) is injected so the agent knows previous local files may no longer exist. Thread sessions stay pinned to their original worker.

**Rebind and `/new` are always allowed** — a running turn is terminated first (abort signaled if the worker is online, marked directly if offline; the run records `failed(interrupted)`), the streaming card is closed with the interruption reason noted, and late events from the old worker are rejected once the run is terminal:

| Session state | Rebind | `/new` (main windows only) |
| --- | --- | --- |
| idle | Session follows the binding; queued messages move with it | Current session closes (transcript retained), `resume_session` schedules are cascade-deleted, a fresh session opens |
| running | Active run terminated as above, then the idle path | Active turn terminated as above, then the idle path |
| worker offline | Migrates immediately; the dead run is marked failed | Treated as idle (no active run) |

`/new` remains rejected inside threads (they auto-compact instead).

## 3. Inbound Decision Chain

When a message arrives, the server applies these gates in order:

1. **Dedup**: drop already-seen `message_id`s (TTL cache).
2. **Space resolution**: resolve `chat_id` → Space; an unbound chat is silent.
3. **Respond gate**:
   - `@bot` is always answered, and marks the thread as **engaged**.
   - A thread reply is answered only in an engaged thread — users do not need to re-mention.
   - Messages mentioning only other bots, and main-stream chatter without a mention, are silent.
4. **Routing**:
   - Window has a live session → reuse it (deliver per §5 semantics).
   - Session creation already in flight for this window → piggyback on the same pending session; a second one is never created.
   - Otherwise → create and dispatch. Creation-time binding depends on session type: private-chat and main-window sessions bind to the space's `boundWorkerId`; thread sessions pick a randomly chosen eligible worker, then stay pinned for life.

### Input Scope

Inbound content is limited to: **text**; **quoted text** (a reply carries the quoted message's sender and body as a `quoted_message` block); and **images** — the server stores only a reference (`{messageId, fileKey, mimeType, sizeBytes}`), never bytes; the worker downloads from Feishu directly using channel credentials injected at dispatch, materializes into the session's `.media/` directory, and passes the agent an `ImageContent`. Download failure, oversize (>10MB), or a model without image input degrade to a placeholder text. File attachments and rich-text card inputs are deferred.

## 4. Turn Batching & Speaker Attribution

Users often send several messages before the bot answers. Consecutive queued turns for the same session are **merged into a single turn** at execution time. A merged turn takes the first message's id as its `turnRef.sourceId` and carries all sources in `mergedSourceIds`; runs pre-created for merged messages close as `merged` with a `mergedIntoRunId` pointer to the run that actually executed. Console injections and ticket receipts use server-generated event ids as their `sourceId`. Every user message in the transcript carries its **author** (display name or open_id), and the worker prefixes user messages with `[author]` when building the agent's context — the agent always knows who said what in multi-party windows.

## 5. Execution Lifecycle

```
[User Message in Thread] ──> [Server Ingestion & Dedupe]
                                      │
                                      ▼
                        [Binding Lookup: Bound Worker]
                                      │
                                      ▼
                        [Worker: Warm or Cold-Start Session]
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
                [Execute Tools]              [Stream Tokens]
                       │                             │
                       └──────────────┬──────────────┘
                                      ▼
                      [Stream to Server via WebSocket]
                                      │
                                      ▼
                      [Server Patches Feishu CardKit]
```

- The session runs on its bound worker. The agent process may stay warm between turns; after TTL eviction or a worker restart, it cold-starts from the server-provided snapshot.
- If the bound worker is offline, messages queue server-side and resume on reconnect — the session never silently migrates.
- Every turn ends with exactly one terminal state: `done` / `interrupted` / `cancelled` / `error` — mapped to run states as `done` → `completed`, the rest → `failed(reason)`.

## 6. Delivery, Steering & Interruption

Incoming work for a session carries one of three delivery semantics:

- **urgent** — end the active turn immediately: the running tool is aborted on arrival, the run is marked `interrupted`, and a new turn starts with the incoming message. `urgent` currently has no producer — it is protocol-reserved; the stop button is the user-facing interrupt.
- **wait** — queue behind the active turn; consecutive queued messages may merge into a single turn.
- **if_idle** — drop when the session is busy.

Source → delivery mapping: user messages, console injections, ticket receipts, and schedule fires are all `wait` (a fire due during an active turn is held and delivered at the next idle moment); `if_idle` is reserved for future low-priority sources.

`/new` syntax: sent directly in private chats; in groups it must @bot. Any user who can drive the bot may use it.

## 7. Streaming to Feishu

The worker emits stream events (`text_delta`, `thinking_delta`, `tool_execution_*`, turn boundaries) to the server, which renders them into a live-updating CardKit card in the session's thread. The card is structured as `[collapsible thinking panel] + [answer markdown] + [tool pills] + [stop button (streaming only)]`; past ~30,000 characters of markdown the stream rolls over to a fresh card. The stop button is limited to the turn's initiating user (persisted on the Run; space members may also stop from the console) and is removed — with streaming mode closed — at terminal state. Proactive/machine turns with no visible output produce no card at all. Rendering mechanics — snapshot frames, throttling, thread anchoring, callback binding — are owned by the Card Streamer module (`specs/architecture/server-control-plane.md`).
