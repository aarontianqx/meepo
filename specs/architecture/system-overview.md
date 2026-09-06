# System Overview Architecture

## 1. High-Level Architecture

MEEPO decomposes the agentic team assistant problem into an asynchronous, capacity-routed system:

```
+-----------------------------------------------------------------------------------+
|                                  Feishu Platform                                  |
|               (Dev Chat / Support Chat / Operations Chat / Threads)               |
+-----------------------------------------------------------------------------------+
                                         │
                        HTTPS Webhook / Secure WebSocket
                                         ▼
+-----------------------------------------------------------------------------------+
|                        MEEPO Central Server (Control Plane)                       |
|                                                                                   |
|  [ Feishu Gateway ] ──> [ Space & Memory Registry ] ──> [ Capacity Router ]       |
|          │                            │                             │             |
|          ▼                            ▼                             ▼             |
|  [ Card Streamer ]          [ Session Store (SST) ]       [ Ticket Queue ]        |
+-----------------------------------------------------------------------------------+
                                         │
                           RPC WebSocket Stream (CBOR/JSON)
                                         ▼
+-----------------------------------------------------------------------------------+
|                         MEEPO Worker Fleet (Data Plane)                           |
|                                                                                   |
|   ┌───────────────────────────┐                  ┌────────────────────────────┐   |
|   │   Private Physical Node   │                  │    Cloud Sandbox Node      │   |
|   │ (MacBook / On-Prem Box)   │                  │   (Dynamic Docker / K8s)   │   |
|   │  - Slots: 1               │                  │  - Slots: 4                │   |
|   │  - Git Worktree: Default  │                  │  - Worktrees: Isolated     │   |
|   │  - Pi Agent Core Runner   │                  │  - Pi Agent Core Runner    │   |
|   │  - Local Tools: Read/Bash │                  │  - Local Tools: Read/Bash  │   |
|   └───────────────────────────┘                  └────────────────────────────┘   |
+-----------------------------------------------------------------------------------+
```

## 2. Architectural Invariants

1. **Server Never Directly Modifies Repositories**: The control plane never executes local shell commands or modifies local workspace files. All disk and execution operations are delegated to workers.
2. **Workers Are Disposable Compute Targets**: Workers do not hold authoritative conversation history or space rules. If a worker disconnects or crashes, no conversational data is lost.
3. **Strict Space Boundary**: Chat messages and agent actions are always fenced by the containing `Space`. A worker assigned to Space A cannot access Space B's long-term memory or session state.
4. **Capacity-Aware Concurrency**: Workers register explicit concurrency slots. Tasks are never assigned to a worker beyond its registered slot limits.
