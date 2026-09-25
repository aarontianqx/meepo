# Proposal: Session Model, Affinity, Triggers & Backend Conventions

- **Date**: 2026-09-25
- **Status**: Accepted
- **Author**: Aaron Tian
- **Title**: Session ownership model, worker affinity, dual scheduling primitives, and backend layering conventions

---

## 1. Context

After the Phase 1 scaffold, we evaluated three reference systems before committing to the interaction and session model:

- **kitty** (`~/workspace/msh/kitty`): a production Feishu↔agent bot with a server/worker split. It maps Feishu threads to sessions via window addressing, but its sessions are worker-owned (context on worker disk, server is only a router).
- **kimi-code** (`~/workspace/github/MoonshotAI/kimi-code`): its cron feature is session-scoped — a fire injects a message into the same agent loop, with state event-sourced into the session log. Its limitation: no fire while the process is down.
- **mars / mireska** (`~/workspace/search-engine/*`): mars demonstrates MoonGate edge authentication (SSO-issued JWT verified locally, no application-side account tables); mireska-engine demonstrates an enforceable layering spec for a heavy backend.

The open questions were: where session truth lives, how chats map to sessions, how scheduled work fires, and how the backend is organized.

## 2. Decisions

### D1. Server owns truth; worker owns live state

The server persists authoritative session transcripts (one ordered event stream per session, plus a materialized current-state projection for queries), space configuration, and ticket state. The worker owns the agent process, the git workspace, and uncommitted changes. This reverses kitty's direction (worker-owned sessions) and is what makes centralized multi-tenancy viable.

### D2. Hard session–worker affinity, space-level binding

A session is pinned to one worker at creation and never migrates implicitly — local code state is fundamental, and prompt-level "commit before you stop" discipline is not a substitute. Binding is a **space configuration** (`boundWorkerId`), defaulting to the first enrolled worker. Main sessions (private-chat and main-window conversations) run on the bound worker and follow it when the user switches; task sessions dispatch to a randomly chosen eligible worker at creation — a routing-policy hook is reserved for identity-aware placement (e.g. preferring the triggering user's own machine) — and stay pinned for life. Offline never means migration: turns queue server-side until the worker returns. Rebinding is a deliberate user action in the console. Tickets are exempt from affinity entirely.

### D3. Thread-mode window mapping

Windows are addressed as `feishu:{chat_id}:{sub_id}`. Only thread mode is supported: every main-stream mention prewarms a new thread and a new session; a thread becomes engaged on first mention so follow-ups need no re-mention; concurrent messages for the same window piggyback on one pending session creation. kitty's `group`/`both` modes are deliberately not adopted.

### D4. Dual scheduling primitives

**Reminder** (task-level): a self-contained objective bundle that fires into a new ticket. **Cron** (session-level): bound to a session, fires a wakeup turn in the same context, with kimi-code's reliability semantics (hold-when-busy, coalescing, jitter) strengthened to at-least-once by the server-side scheduler. Crons are one-shot or recurring; recurring crons expire after a 7-day staleness TTL (one final fire marked `stale`, then auto-delete) so forgotten automation cannot run forever — reminders are exempt. Cron records are server-side, session-scoped, and cascade-deleted with the session; workers hold no timers.

### D5. Unified trigger model

User messages, reminders, crons, and webhooks share one dispatch pipeline, distinguished by `source` and delivery semantics (`urgent` / `wait` / `if_idle`), forking into exactly two paths: ticket dispatch (new context) and session wakeup (existing context).

### D6. Edge authentication; space membership for authorization

Users authenticate via edge SSO (MoonGate is the planned adapter, decoupled behind a port); the server verifies the injected token and extracts a normalized identity. MEEPO maintains no account system. Authorization is MEEPO-owned **space membership**: a `(spaceId, userId) → role` table, unique per user per space — every authorized member holds management rights, and exactly one member is the `owner`. Workers authenticate separately, with enrollment tokens. The `Authenticator` is a port so the identity provider can be swapped later.

### D7. Backend layering conventions

`transport → domain → store` one-way; ports defined at the consumer; constructor injection from a single composition root; domain-segmented error codes; dependency rule enforced by ESLint. Codified in `specs/architecture/backend-layering.md`.

### D8. Server-held model credentials

Model provider credentials are stored per space by the server and injected into each dispatch envelope; workers hold no LLM keys of their own. TLS on the worker channel is a prerequisite for real credentials, and keys landing on user-owned machines is an accepted risk (shared machines must be flagged). Centralized rotation, billing, and quota become possible.

### D9. Timezone handling

All scheduling stores and compares in UTC. Each reminder/cron record carries a `timezone` (IANA) defaulting to the **space's configured timezone** — never the worker's local timezone, since the server is authoritative. Timezone-naive inputs are interpreted in the record's timezone; cron expressions are strictly 5-field.

## 3. Consequences

- Session migration between workers is no longer a system concern; it is an explicit user action with documented state loss. This removes the hardest class of edge cases at the cost of sessions pausing when their worker is offline.
- The dispatch envelope needs no full-context snapshot per turn — only cold-start rehydration (full, then incremental) on the bound worker.
- The server gains a scheduler module and a session event-stream store earlier than the original roadmap implied; both land before the Feishu integration is complete.
- The Phase 1 scaffold's `Account` entity and `Space.ownerAccountId` are superseded by the space membership table and must be aligned in code.

## 4. References

- kitty session routing: `kitty-server/src/kitty_server/router.py`, window bindings, piggyback creation (`im/core.py`)
- kimi-code cron: `packages/agent-core-v2/src/features/cron/` (durable events in `wire.jsonl`, coalescing, hold-when-busy)
- mars MoonGate auth: `apps/community-console-web/src/server/moongateAuth.ts`, weaver-engine `internal/infra/auth/moongate.go`
- mireska layering spec: `specs/architecture/mireska-backend.md`
