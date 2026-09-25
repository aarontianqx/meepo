# Feature: Interactive Streaming Session

## 1. Overview

Interactive Sessions provide real-time, bidirectional communication between Feishu users and a MEEPO worker executing tasks in the context of an ongoing thread.

## 2. Windows and Sessions

A **window** is the IM address a session is bound to: `window_id = feishu:{chat_id}:{sub_id}`. One window maps to at most one active session; the window→session mapping is persisted so it survives server restarts.

**Private chat** — one main session per user (`sub_id = sender open_id`), no threads anywhere: the bot always replies in the main flow. The session auto-compacts when it grows long; `/new` closes it and starts a fresh one.

**Group chat** — two session shapes coexist:

- **Thread sessions** (`sub_id = thread_id`, kind `task`): one per thread, used for focused coding work. When the bot is first mentioned midway through a thread, the new session is seeded with the thread's existing history so it has the full context.
- **The group's main session** (`sub_id = _group`, kind `main`): the long-lived conversation of the main stream. A **reply** that involves the bot (a reply mentioning it) continues this session and is answered in the main flow — it never spawns a thread.

Routing inside the group main stream: a fresh `@bot` mention (not a reply) prewarms a **new thread** and a new task session; a reply mentioning the bot goes to the group main session.

**`/new` rotates a main session** (private chat or group main flow): it closes the current session (transcript retained server-side) and opens a fresh one. It is rejected inside threads — threads auto-compact instead.

A space designates one window as its **main window** — carrier-agnostic: the owner's private chat or a designated group thread. The session there is the space's **main session**, the only session flagged `no_workspace` (it orchestrates and never edits code), which is what allows it to follow a space rebind losslessly.

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
   - Otherwise → create and dispatch. Creation-time binding depends on session type: private-chat and main-window sessions bind to the space's `boundWorkerId`; task sessions pick a randomly chosen eligible worker, then stay pinned for life.

## 4. Turn Batching & Speaker Attribution

Users often send several messages before the bot answers. Consecutive queued turns for the same session are **merged into a single turn** at execution time. Every user message in the transcript carries its **author** (display name or open_id), and the worker prefixes user messages with `[author]` when building the agent's context — the agent always knows who said what in multi-party windows.

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
- Every turn ends with exactly one terminal state: `done` / `interrupted` / `cancelled` / `error`.

## 6. Delivery, Steering & Interruption

Incoming work for a session carries one of three delivery semantics:

- **urgent** — steer into the active turn: the message is injected into the agent's follow-up queue and takes effect as soon as the running tool finishes or is cancelled.
- **wait** — queue behind the active turn; consecutive queued messages may merge into a single turn.
- **if_idle** — drop when the session is busy.

## 7. Streaming to Feishu

The worker emits stream events (`text_delta`, `tool_execution_*`, turn boundaries) to the server, which renders them into a live-updating CardKit card in the session's thread. Rendering mechanics — snapshot frames, throttling, thread anchoring, callback binding — are owned by the Card Streamer module (`specs/architecture/server-control-plane.md`).
