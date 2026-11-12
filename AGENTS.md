# Meepo -- Agent Guidelines

## Documentation Management Rule

To prevent diluting the context window with redundant or overly detailed business logic, Meepo documents are strictly split into three categories:

1. **`AGENTS.md` (This File)**: STRICTLY for high-level coding constraints, directory structures, and critical rules (the "laws" for the coding agent). Must be kept concise.
2. **`README.md`**: STRICTLY for human onboarding, local setup, and deployment instructions.
3. **`specs/` Directory**: STRICTLY for detailed architectural designs, business logic, module descriptions, and domain behaviors (`specs/README.md` defines the glossary, reading map, and full authoring standard — read it before editing `specs/`). It is further divided into specific domains:
   - `specs/architecture/`: Evergreen system-level designs. Keep up-to-date when architecture changes.
   - `specs/features/`: Evergreen functional domain behaviors. Keep up-to-date when features evolve.
   - `specs/proposals/`: Point-in-time ADRs (Architecture Decision Records), refactoring plans, and design drafts. May be outdated — do not blindly trust. Always verify against current code. Evergreen docs must not cite proposals; hoist durable rules into the relevant evergreen doc.

Evergreen specs must remain self-contained and implementation-independent: specify logical schemas, endpoints, state machines, and limits directly (never substitute `"see packages/..."` for a contract), preserve design rationale, rewrite affected sections cleanly in place within the same task as any contract change (no patch postscripts, internal helper names, or migration numbers), and isolate stage limits under `Current Implementation Notes`. Write `AGENTS.md`, `README.md`, and evergreen `specs/` in English; `specs/proposals/` may be written in the developer's preferred language.

## Project Structure & Verification

Meepo is a monorepo managed by [Moon](https://moonrepo.dev/) and [pnpm](https://pnpm.io/) workspaces.

```
meepo/
  apps/
    meepo-server/          # Control plane: channel gateways, space/session/memory store, dispatcher, scheduler
    meepo-worker/          # Execution data plane: isolated per-task directories, agent loop, local & MCP tools
    meepo-console/         # Management & observation console (Vite + React SPA)
  packages/
    core/                  # Shared domain entity interfaces
    protocol/              # Wire envelopes, RPC schemas, streaming events, payload bounds
    sdk/                   # Reserved placeholder stub (do not place domain or client logic here)
  specs/                   # Specification charter (specs/README.md), architecture, features, and proposals
```

- Rebuild shared packages (`pnpm build`) before testing downstream apps; run `pnpm format` and `pnpm check` (lint + typecheck + test + spec hygiene) before finishing.
- `pnpm build` runs `pnpm dedupe` — discard incidental `pnpm-lock.yaml` metadata diffs when dependencies are unchanged.

## Coding Style & Guard Rails

### Architecture & Security Constraints

- **Server Owns Truth; Worker Owns Live State**: `meepo-server` is the SST for spaces, memory, canonical transcripts, tickets, schedules, and runs. Workers own live agents, task directories, MCP processes, and uncommitted files (stateless across tickets, sticky for sessions); never run task commands or manage git repos on the server.
- **Hard Session Affinity**: `main` sessions follow `space.boundWorkerId` (offline queues and waits; explicit rebind interrupts and migrates them); `thread` sessions pin to their initial worker for life. Tickets are exempt and receive structured objective bundles (never raw chat logs) in fresh `<ticketsDir>/<id>/attempt-N` directories.
- **Slot & Prompt Discipline**: Worker `SlotSemaphore` caps all local runs (interactive turns prioritized over tickets) in isolated per-task directories; `git worktree` rules belong only to the opt-in `coding` preset. Session identity/preset freezes at creation (`prompt_identity`), dynamic per-turn state (e.g. current time) rides in turn messages, and the cold-refreshed `Memory Map` stays at the very end of the system prompt to preserve KV-cache hits.
- **Cross-Entity Atomicity (`Tx*` Ports)**: `store/memory/*` doubles do not enforce multi-entity transactions — commit cross-entity transitions via SQLite `Tx*` ports and verify with SQLite tests. Exception: `SqliteTicketRepository.save()` cascades run fencing and origin receipts on terminal tickets; never replace it with a row-only write.
- **Auth & Secret Boundaries**: Read identity only from `Authenticator` request context (no account table); authorize existing resources against their **stored** `spaceId` and reject path/query/body `spaceId` conflicts (`admin` manages `Models`/`Channels` only). Channel secrets/tokens never leave the server (`media.read` proxies images), `DispatchQueue` omits raw `apiKey`s, IM tool pills hide args/results, and worker tool RPCs require an unexpired `running` `runId` lease without mixing `sessionId` and `ticketId`.
- **Layering, Migrations & Protocol**: `transport → domain → store` one-way (`infra` dependency-free); consumer-defined ports in `domain/` wired via constructor injection in `bootstrap.ts`. SQLite migrations (`migrations.ts`) are append-only; breaking `/ws/worker` changes must bump `CURRENT_PROTOCOL_VERSION` in `@meepo/protocol`.

### TypeScript & Commits

- Strict TypeScript (`strict: true`), Prettier + `typescript-eslint`, named exports, no `any` outside justified serialization boundaries, and no dynamic `import()` in shared core packages unless lazy-loading provider SDKs.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`). Do not commit directly unless explicitly instructed by the user.
