# Server Control Plane Architecture

The `meepo-server` application coordinates multi-chat inbound traffic, manages spaces, persists long-term memory, tracks session state, and dispatches workload to available workers.

## Core Modules

### 1. Feishu Gateway
- Ingests incoming events via Feishu Webhook HTTP endpoints or Feishu WebSocket long connection.
- Verifies message authenticity and signatures.
- Performs event deduplication based on `event_id` and `message_id`.
- Resolves inbound target: maps Feishu `chat_id` to `space_id` and `root_id` / `parent_id` to `session_id`.

### 2. Space & Memory Manager
- Maintains configuration for each Space:
  - Repository URL, default branch, target languages.
  - Allowed worker tags (e.g. `[macos, dev, private]`).
  - Space Long-Term Memory: persistent business conventions, architectural rules, and curated knowledge summaries.
- Periodically accepts proposed knowledge deltas from completed tasks and merges them into the persistent space memory.

### 3. Session Store (Single Source of Truth)
- Persists full multi-turn conversational transcripts using `@earendil-works/pi-agent-core`'s `AgentMessage` data structures.
- Tracks active task state, streaming buffer, and turn execution status.
- Provides session snapshots to workers when resuming or reconnecting an interactive session.

### 4. Dispatcher & Load Balancer
- Monitors connected worker nodes via heartbeat stream.
- Maintains active routing table: `sessionId -> workerId`.
- Schedules tasks using a multi-tier strategy:
  1. **Session Affinity**: Route to the worker already holding the active session.
  2. **Tag Matching**: Match worker capabilities to space requirements.
  3. **Capacity Slot Balancer**: Allocate to workers with available capacity slots (`activeSessions < maxSlots`), preferring the least-loaded worker.
  4. **Overflow / Queue**: If slots are saturated, queue tasks or signal elastic sandbox spin-up.

### 5. Card Streamer
- Converts worker stream events (`message_update`, `tool_execution_start`, `tool_execution_end`) into Feishu CardKit dynamic updates.
- Throttles CardKit patch calls to adhere to Feishu rate limits while providing smooth streaming output.
