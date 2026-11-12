# Meepo System Specifications

This directory holds the authoritative architectural and functional specifications for Meepo.

## 1. Purpose and Authoring Standard

`specs/architecture/` and `specs/features/` form a **self-contained, implementation-independent design specification** of the system:

- **Implementation Sufficiency**: Together, the evergreen specifications define Meepo's domain models, invariants, state machines, wire protocols, HTTP APIs, prompt/context assembly rules, security boundaries, limits, and failure semantics with enough precision to build an interoperable or clean-room implementation in any language without reading the current TypeScript codebase.
- **Abstraction Discipline**: Specifications stay at the level of system boundaries, logical schemas, observable contracts, and behavioral invariants. Framework-internal mechanics, private helper names, test-double limitations, and historical database migration numbers do not belong in evergreen documents.
- **Preserved Rationale**: Non-obvious constraints carry concise inline explanations of _why_ they exist (for example, protecting prompt prefix caches, preventing silent loss of uncommitted local files, avoiding duplicate external side effects, or keeping secrets out of group chat cards) so future contributors and coding agents do not inadvertently remove load-bearing decisions.
- **Cohesive Maintenance**: Evergreen documents always describe the current system as an integrated whole. When requirements evolve, update the relevant sections cleanly in place rather than appending dated patch notes. Stage-specific limitations (such as single-replica SQLite or pending edge SSO) are isolated in `Current Implementation Notes` sections at the end of the relevant document; point-in-time planning, ADRs, and refactoring backlogs live exclusively in `specs/proposals/` and must never be linked from evergreen specs.
- **Language Convention**: Evergreen specifications (`specs/architecture/`, `specs/features/`, and this file), `README.md`, and `AGENTS.md` are written in clear English (retaining exact user-facing strings verbatim where specified); `specs/proposals/` may be written in the developer's preferred language.

## 2. Authoring Mechanics and Maintenance Rules

### 2.1 Single-Owner Rule (Avoid Cross-Document Drift)

Each kind of contract has **one authoritative home**. Other documents summarize behavior and link to the owner rather than copying large field or route tables:

- **Entity schemas, field constraints, uniqueness invariants, and retention**: [`architecture/domain-model.md`](architecture/domain-model.md)
- **External HTTP REST routes, status/error mappings, webhooks, and Console WebSocket**: [`architecture/control-plane-api.md`](architecture/control-plane-api.md)
- **`/ws/worker` JSON-RPC methods, downstream notifications, and sequenced stream events**: [`architecture/worker-protocol.md`](architecture/worker-protocol.md)
- **System prompt assembly order, refresh cadence, turn wrappers, and event rehydration**: [`features/prompt-and-context.md`](features/prompt-and-context.md)
- **Domain workflows, state machines, edge cases, and user-visible behavior**: the corresponding file under `specs/features/`

### 2.2 Required Document Anatomy

1. **Title & Scope Banner**: Every file in `specs/architecture/` and `specs/features/` must open with `# <Title>` followed immediately by `> **Scope**: <1–2 sentences defining what this document owns and pointing to adjacent contract owners>` (verified mechanically by `pnpm check`).
2. **Present-Tense Contracts + Inline Rationale**: State rules as timeless invariants. Attach `*Rationale: ...*` wherever a constraint looks counter-intuitive at first glance (e.g., why `Memory Map` is a trailing suffix, why `thread` sessions do not follow space rebinds, why tool pills omit arguments).
3. **Isolated Stage Constraints**: Place temporary implementation caveats (single-process SQLite, header dev auth, unimplemented UI test suites) at the bottom under `## Current Implementation Notes` (or numbered equivalent) so readers never mistake temporary scope for architectural intent.

### 2.3 Change-to-Spec Routing Checklist

Any code change that alters an observable contract or invariant must update its owning specification(s) in the **same task**:

| Code / Behavioral Change                                                            | Specifications to Update                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Persisted entity fields, constraints, uniqueness rules, or retention windows        | `architecture/domain-model.md` (+ owning feature spec if lifecycle changes)                        |
| HTTP route, request/response shape, auth gate, error code, webhook, or Console WS   | `architecture/control-plane-api.md` (+ `features/console.md` if operator workflow changes)         |
| `/ws/worker` RPC, notification, stream event, ACK/lease rule, or payload bound      | `architecture/worker-protocol.md` + `architecture/worker-data-plane.md`                            |
| Cross-entity atomic transaction (`Tx*`), server maintenance loop, or secret storage | `architecture/server-control-plane.md`                                                             |
| Local workspace tool, MCP reload, directory/media cache, model effort, compaction   | `architecture/worker-data-plane.md` (+ `features/ticket-pipeline.md` if read-only allowlist moves) |
| System prompt text, freeze/refresh rules, turn XML/text wrappers, event rehydration | `features/prompt-and-context.md`                                                                   |
| Space/Channel/Window routing, roles, `/new`, space rebind, or IM card rendering     | `features/space-and-chat.md` / `features/interactive-session.md`                                   |
| Ticket state machine, retry eligibility, receipts, or `Schedule` / `Run` behavior   | `features/ticket-pipeline.md` / `features/triggers-and-scheduling.md`                              |
| Space memory constraints, Memory Map rendering, search ranking, or Console pages    | `features/memory.md` / `features/console.md`                                                       |
| Adding, renaming, or removing an evergreen spec file                                | Register in §4 Reading Map below (verified mechanically by `pnpm check`)                           |

### 2.4 Concrete Do / Don't Examples

- **Do not delegate contracts to source files**
  - _Don't_: `"Channel fields live in channel-service.ts; see packages/core for Session fields."`
  - _Do_: Define logical fields, types, constraints, uniqueness rules, and secret-redaction semantics directly in `architecture/domain-model.md`.
- **Rewrite cleanly in place; never append chronological patch notes**
  - _Don't_: `"Update (R5): Schema 20 deletes legacy session_compactions rows because v18/v19 could not track inherited degradation."`
  - _Do_: `"Degraded prefix caches never overwrite clean caches at the same boundary and are excluded from cold-start snapshots so subsequent cold starts retry from raw events."`
- **State domain invariants, not internal test-double debt**
  - _Don't_: `"MemoryTicketRepository only saves rows, whereas SqliteTicketRepository.save() also fences runs; refactoring TicketRepository is pending."`
  - _Do_: Specify the atomic ticket-cancellation + run-fencing + receipt invariant in `server-control-plane.md` (and track interface cleanup in `specs/proposals/`).

## 3. Core Domain Glossary

Every specification uses these terms with strict, non-overlapping meanings:

| Term                | Definition                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Space**           | Tenant and business boundary owning configuration, memberships, channels, memory entries, sessions, tickets, and schedules. Never shares data across spaces.         |
| **Channel**         | One registered IM bot application (e.g., a Feishu app) bound to exactly one Space. A Space may own multiple Channels.                                                |
| **Window**          | A concrete conversation address under a Channel (`{channelId}:{chatId}:{subId}`) — a private chat, a group main stream, or a group thread.                           |
| **Session**         | Durable conversation container bound at most 1:1 (while active) to a Window, pinned to a single Worker (`main` or `thread` kind).                                    |
| **Turn**            | One in-session execution unit (`turnRef = {sessionId, sourceId}`) continuing an existing Session's context on its bound Worker.                                      |
| **Ticket**          | An independent, self-contained asynchronous work unit with an explicit objective, executed in a fresh neutral directory on any eligible Worker.                      |
| **Schedule**        | Durable server-side trigger (`at` one-shot or `cron` recurring) whose firing atomically produces either a `Ticket` (`create_ticket`) or a `Turn` (`resume_session`). |
| **Run**             | A single execution attempt of either a `Ticket` or a `Turn` on a Worker, owning lease state, sequenced stream events, token usage, and terminal status.              |
| **Worker**          | Self-hosted execution daemon connecting outbound to the server, managing isolated per-task directories, local/MCP tools, and an execution slot semaphore.            |
| **Slot**            | Concurrency unit on a Worker bounding simultaneously executing Runs across both interactive Turns and asynchronous Tickets.                                          |
| **Memory Entry**    | Curated, space-scoped knowledge document (`path`, `description`, `keywords`, `content`, monotonic `revision`) guarded by optimistic locking and tombstones.          |
| **Canonical Event** | Durable, monotonically sequenced record in a Session transcript (`seq`) or Run execution journal (`clientSeq`), excluding transient streaming deltas.                |

## 4. Reading Map

### Architecture (`specs/architecture/`)

Read these to understand system boundaries, data schemas, protocols, and structural invariants:

1. [**System Overview**](architecture/system-overview.md) — End-to-end topology, execution pipeline, seven core architectural invariants, and trust model.
2. [**Domain Model**](architecture/domain-model.md) — Canonical logical entities, field constraints, uniqueness rules, and retention policies.
3. [**Server Control Plane**](architecture/server-control-plane.md) — Control-plane subsystems, cross-entity atomic transactions, authentication/encryption, and background loops.
4. [**Control Plane API**](architecture/control-plane-api.md) — External HTTP REST routes, webhook ingestion, Console WebSocket streaming, and error contracts.
5. [**Worker Data Plane**](architecture/worker-data-plane.md) — Runner lifecycle, directory/media isolation, built-in local tools, MCP hot-reload, model resolution, and compaction.
6. [**Worker Protocol**](architecture/worker-protocol.md) — Versioned `/ws/worker` JSON-RPC framing, handshake/reconciliation, sequenced event ACKs, and lease fencing.
7. [**Backend Layering**](architecture/backend-layering.md) — Dependency direction, consumer-owned ports, composition root discipline, and monorepo enforcement.

### Features (`specs/features/`)

Read these to understand domain workflows, user-facing behavior, and state machines:

1. [**Space and Chat Mapping**](features/space-and-chat.md) — `Space → Channel → Window` routing, membership roles, worker enrollment, and binding rules.
2. [**Interactive Session**](features/interactive-session.md) — Window session lifecycles, inbound decision chain, turn merging, `/new` and rebind transitions, and card streaming.
3. [**Prompt and Context Assembly**](features/prompt-and-context.md) — Two-stage system prompt rendering, refresh timing, turn message framing, and cold-start event rehydration.
4. [**Ticket Pipeline**](features/ticket-pipeline.md) — Asynchronous task state machine, conservative retry policy, idempotency keys, cancellation, and origin receipts.
5. [**Triggers and Scheduling**](features/triggers-and-scheduling.md) — Unified `Schedule → Ticket | Turn | Run` execution model, cron/jitter/coalescing rules, and agent scheduling tools.
6. [**Space Memory**](features/memory.md) — Entry constraints, tombstone-backed revisions, deterministic Memory Map injection, trigram search, and memory tools.
7. [**Management Console**](features/console.md) — Administrative and observational UI capabilities, role matrix, live transcript viewing, mailbox injection, and manual review.

### Historical Proposals (`specs/proposals/`)

Point-in-time design brainstorms, milestone trackers, and verification logs retained for historical context. They are never authoritative over `architecture/` or `features/`.
