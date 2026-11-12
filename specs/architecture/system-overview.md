# System Overview

> **Scope**: Defines Meepo's end-to-end runtime topology, unified execution pipeline, core architectural invariants with their underlying design rationale, and security trust boundaries. Subsystem internals and wire contracts live in their respective plane specifications.

## 1. Purpose and Topology

Meepo is a multi-tenant collaborative agent platform accessed primarily through instant messaging (currently Feishu) and managed through a web console. Rather than coupling bot state to local agent disks or forcing every workspace onto centralized cloud containers, Meepo splits **durable control-plane state** from **distributed, self-hosted execution workers**:

```text
IM Channels (Feishu bots) ── outbound WebSocket per channel ──► Control-Plane Server ◄── HTTP REST & WS ── Console / Webhooks
                                                                        │
                                                        Durable Store: Spaces, Channels,
                                                        Models, Memory, Transcripts,
                                                        Tickets, Schedules, Runs, Outboxes
                                                                        │
                                                        Authenticated JSON-RPC WebSocket
                                                        (/ws/worker, outbound from worker)
                                                                        ▼
                                                             Self-Hosted Workers:
                                                             Agent loop, local tools,
                                                             MCP servers, task directories
```

Workers dial outbound to the server over WebSocket using pre-issued enrollment tokens, allowing developer workstations, on-premises hosts, and NAT-isolated containers to participate without inbound firewall exposure.

### Unified Execution Pipeline

All work in Meepo flows through a single domain pipeline:

```text
Schedule (at | cron) ──fires──► Ticket | Turn ──dispatched as──► Run
                                  ▲        ▲
             HTTP / Webhook / Tool┘        └── IM Window / Console Mailbox / Ticket Receipt
```

- A **Space** is the sovereign tenant boundary owning configuration, memberships, channels, memory, sessions, tickets, and schedules.
- A **Session** (`main` or `thread`) binds an IM window (or console session) to a persistent conversation transcript and a single worker. A **Turn** continues that session in place.
- A **Ticket** is a self-contained asynchronous objective executed in a fresh neutral directory on any eligible worker.
- A **Run** represents a single execution attempt of either a Turn or a Ticket, anchoring leases, sequenced stream events, and token usage.

## 2. Architectural Invariants

1. **Server owns durable truth; workers own live execution state.**
   Space configuration, curated memory, canonical session transcripts, ticket/run states, and schedules are persisted exclusively on the server. Workers hold live agent processes, task directories, local tool artifacts, and uncommitted repository state. Only server-acknowledged events are durable; a worker crash may lose unacknowledged local events, while a cold-started runner reconstructs context from the server's last confirmed sequence.
   _Rationale: Keeping transcripts and orchestration state on the server makes workers disposable for tickets, auditable from a central console, and resilient to machine restarts without requiring distributed filesystem sync._

2. **All task execution stays on workers.**
   The server never executes user shell commands, clones repositories, or spawns MCP servers. Concurrent tasks on a worker execute in distinct per-task directories (`<sessionsDir>/<sessionId>` and `<ticketsDir>/<ticketId>/attempt-N`). Repository cloning and `git worktree` discipline are opt-in prompt conventions (`coding` preset), not harness constraints, and git/SSH credentials remain entirely in the worker host's local environment.
   _Rationale: Separating control-plane persistence from arbitrary tool execution isolates the server from untrusted code execution and avoids assumptions that every space is a software repository._

3. **Interactive sessions enforce hard worker affinity; tickets are stateless across attempts.**
   Main sessions (`private` and `group-main`) bind to the space's `boundWorkerId`; thread sessions select an eligible online worker at creation and remain pinned for life. When a session's worker goes offline, incoming turns queue server-side and wait rather than migrating silently. Explicit space rebinding interrupts and migrates main sessions (abandoning old local files with a `system_note` while preserving the transcript) so primary chat windows never become permanently bricked when a host dies, whereas thread sessions stay pinned so in-progress local edits are never silently orphaned. Tickets start every attempt in a fresh directory and may be claimed by any eligible worker.

4. **Concurrency is bounded locally per worker with interactive priority.**
   Each worker enforces a single `maxSlots` semaphore across all executing runs. When a slot frees up, queued interactive session turns acquire capacity ahead of background tickets. The server also tracks reported slot utilization to place tickets on least-loaded workers, but never uses slot pressure to migrate pinned sessions.
   _Rationale: Local enforcement prevents host overload regardless of dispatch races, while prioritizing turns keeps human conversations responsive during batch ticket bursts._

5. **Identity comes from the edge; authorization is strictly per space.**
   Meepo maintains no user account database. Request identity is extracted solely through an `Authenticator` port from verified request context — never from request bodies or query parameters. Conflicting `spaceId` parameters across path, query, and body are rejected before resource access, and existing resources are authorized against their stored `spaceId`. Space membership (`owner` or `operator`) governs all space resources; a separate global `admin` role manages only shared model and channel registries and grants zero visibility into private spaces.

6. **Shared workers constitute a shared trust domain.**
   Server APIs isolate spaces strictly at the control-plane boundary, and a worker can serve only spaces authorized by its enrollment token (bound 1:1 to its `workerId`). However, enrolling a single worker across multiple spaces shares that host's OS user, filesystem, local credentials, and MCP servers across those spaces. Model API keys are encrypted at rest on the server and injected per dispatch to authorized workers (making worker operators trusted with dispatched model keys), whereas IM channel `appSecret`s and tenant tokens never leave the server (session images are fetched through an authorized server proxy). Within a bound chat window, any admitted IM participant may converse with the bot and invoke its full tool set without requiring console membership or per-tool approval gates.
   _Rationale: Avoiding interactive tool-approval state machines preserves conversational flow and prompt cache stability; public or untrusted group spaces should therefore enroll dedicated, unprivileged container workers._

7. **Reliability fences stale writes without claiming exactly-once external side effects.**
   Monotonic `(runId, clientSeq)` acknowledgments, heartbeat-renewed execution leases, and transactional outboxes prevent split-brain state corruption and duplicate transcript entries. When a worker loses its lease mid-execution, external side effects (shell commands, third-party API calls) have unknown outcomes: session turns fail explicitly as `lease_lost`, and tickets auto-retry only when never started, explicitly marked `idempotent`, or proven read-only by persisted tool events — otherwise parking in `manual_review`.

## 3. Current Implementation Notes

- **Single-instance control plane**: The server currently runs as a single process backed by embedded SQLite and serves the built console SPA directly. Per-channel Feishu WebSocket long connections deliver each event to one connected client instance, which likewise assumes a single active gateway replica. Horizontal scale-out (PostgreSQL storage adapter, webhook event ingestion, shared connection ownership) is deferred.
- **Development authenticator**: Until edge SSO/JWT verification is wired, a header-based `Authenticator` adapter (`x-meepo-user-id`) serves local development on `127.0.0.1`. Production startup refuses this adapter unless `MEEPO_ALLOW_INSECURE_HEADER_AUTH=1` explicitly opts in for an isolated network.

## 4. Contract Ownership

| Topic                                                  | Authoritative Specification                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Canonical entities, field constraints, retention       | [Domain Model](domain-model.md)                                   |
| Server subsystems, auth/secrets, atomic transactions   | [Server Control Plane](server-control-plane.md)                   |
| HTTP REST endpoints, webhooks, console stream, errors  | [Control Plane API](control-plane-api.md)                         |
| Worker lifecycle, directories, local/MCP tools, budget | [Worker Data Plane](worker-data-plane.md)                         |
| `/ws/worker` JSON-RPC framing, ACKs, leases            | [Worker Protocol](worker-protocol.md)                             |
| Layer dependency direction and port placement          | [Backend Layering](backend-layering.md)                           |
| `Space → Channel → Window` routing and roles           | [Space and Chat Mapping](../features/space-and-chat.md)           |
| Window lifecycles, batching, `/new`, card streaming    | [Interactive Session](../features/interactive-session.md)         |
| System prompt assembly, refresh rules, rehydration     | [Prompt and Context Assembly](../features/prompt-and-context.md)  |
| Ticket state machine, retry policy, receipts           | [Ticket Pipeline](../features/ticket-pipeline.md)                 |
| `Schedule → Ticket \| Turn → Run` timing and tools     | [Triggers and Scheduling](../features/triggers-and-scheduling.md) |
| Curated memory entries, Memory Map, trigram search     | [Space Memory](../features/memory.md)                             |
| Console pages, role capabilities, live observation     | [Management Console](../features/console.md)                      |
