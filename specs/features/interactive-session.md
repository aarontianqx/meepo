# Feature: Interactive Streaming Session

## 1. Overview

Interactive Sessions provide real-time, bidirectional communication between Feishu users and a MEEPO worker executing tasks in the context of an ongoing thread.

## 2. Thread-to-Session Mapping

- In Feishu, every message within a thread shares a common `root_id` (or `thread_id`).
- MEEPO maps `root_id` to an internal `sessionId`.
- Initial `@bot` mention in a top-level message creates a new Session.
- Subsequent replies within the thread append turns to the active Session.

## 3. Execution Lifecycle

```
[User Message in Thread] ──> [Server Ingestion & Dedupe]
                                      │
                                      ▼
                        [Capacity Router: Match Worker]
                                      │
                             (Session Affinity)
                                      ▼
                        [Worker: Load Workspace & Agent]
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

## 4. Steering & Interruption

If the user sends a message while the agent is executing tools (e.g., waiting for a long build or test command):
- Server recognizes the in-flight state and sends a `steer` payload to the assigned worker.
- Worker injects the message into `agent.steer()`, allowing the agent to adjust its plan as soon as the active tool finishes or is cancelled.
