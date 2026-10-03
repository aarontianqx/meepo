# System Overview

## 1. Deployment and ownership

Meepo is a general-purpose collaborative assistant accessed through Feishu, with optional coding presets. The current deployment is **one server with SQLite and multiple self-hosted workers**. The server also serves the console. PostgreSQL, multiple server replicas and edge SSO integration are planned, not implemented.

```text
Feishu bots ── per-channel WebSocket ──► Server ◄── HTTP / event WebSocket ── Console
                                       │
                           SQLite: configuration, events,
                           runs, tickets, schedules, outboxes
                                       │
                           authenticated JSON WebSocket
                                       ▼
                           Workers: Pi runtime, tools,
                           MCP, per-task directories
```

The execution model is `Schedule → Ticket | Turn → Run`, with turns belonging to a Session. A Space owns configuration, memory and execution records; each Channel is one bot application assigned to one space. See [space and chat mapping](../features/space-and-chat.md) and [triggers and scheduling](../features/triggers-and-scheduling.md).

## 2. Architectural invariants

1. **Server owns durable truth.** Space configuration, memory, transcripts, ticket/run state and schedules are persisted server-side. Workers own live agents, local files and uncommitted changes. Only server-confirmed events are guaranteed durable; a worker crash may lose unacknowledged local events or tool outcomes.
2. **Execution stays on workers.** The server persists its own data but does not execute task shell commands or manipulate task repositories. Each concurrent task uses an isolated directory. Repo checkout/worktree behavior is an optional prompt convention, not a harness requirement.
3. **Sessions have hard affinity.** Main sessions use the space binding; thread sessions select an eligible worker and stay pinned. Offline means queue and wait. Explicit rebind interrupts and moves main sessions, preserves their transcript, and abandons old local state; existing thread sessions keep their worker. Tickets use fresh attempt directories and may retry elsewhere under the ticket retry policy.
4. **Capacity is enforced locally.** One worker semaphore covers all runs; released slots favor interactive turns over tickets. The server also reserves ticket capacity, but does not use slot availability to migrate sessions.
5. **Server authorization is per space.** User identity comes through an Authenticator port; the current adapter uses a development header, and a signed edge-token adapter is pending. The default listener is loopback; production startup rejects this adapter unless explicitly opted in for an isolated environment. Conflicting request space identifiers are rejected before resource access. There is no account system. Members have owner/operator roles; global admins manage registries without automatically gaining private-space access.
6. **Shared workers are a shared trust domain.** Server APIs enforce resource ownership. Sharing a worker does not isolate files, environment credentials or MCP tools between spaces. A worker may serve only spaces covered by its enrollment token. Worker owners can inspect dispatched model API keys; registry redaction does not hide them from enrolled execution hosts. Channel app secrets and tenant tokens remain server-side; image RPCs authorize a referenced resource within the bound session. IM participants admitted by channel routing may use the full agent tool set without console membership; there is no approval mode.
7. **Reliability does not imply exactly-once side effects.** Event ACKs, fencing and transactional outboxes prevent stale state writes and support recovery. Unknown external tool outcomes are not blindly replayed; ticket retry eligibility is explicit.

## 3. Contract ownership

| Topic                                              | Authoritative document                                            |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Server modules, auth, cross-entity transactions    | [Server control plane](server-control-plane.md)                   |
| Local runtime, prompt/model timing, files and MCP  | [Worker data plane](worker-data-plane.md)                         |
| Wire format, reconnect, ACK and leases             | [Worker protocol](worker-protocol.md)                             |
| Layer dependencies and port placement              | [Backend layering](backend-layering.md)                           |
| Space/channel routing and membership               | [Space and chat](../features/space-and-chat.md)                   |
| Window lifecycle, delivery and user interruption   | [Interactive session](../features/interactive-session.md)         |
| Independent work, retry, cancellation and receipts | [Ticket pipeline](../features/ticket-pipeline.md)                 |
| Scheduling and execution identities                | [Triggers and scheduling](../features/triggers-and-scheduling.md) |
| Memory schema, retrieval and tools                 | [Memory](../features/memory.md)                                   |

Field-level wire types live in `packages/protocol`; shared entity types live in `packages/core`. Evergreen documents describe current behavior and label implementation limitations explicitly. Operational setup belongs in the repository README.
