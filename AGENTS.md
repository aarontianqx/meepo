# Meepo -- Agent Guidelines

## Documentation Management Rule

To prevent diluting the context window with redundant or overly detailed business logic, Meepo documents are strictly split into three categories:

1. **`AGENTS.md` (This File)**: STRICTLY for high-level coding constraints, directory structures, and critical rules (the "laws" for the coding agent). Must be kept concise.
2. **`README.md`**: STRICTLY for human onboarding, local setup, and deployment instructions.
3. **`specs/` Directory**: STRICTLY for detailed architectural designs, business logic, module descriptions, and domain behaviors. It is further divided into specific domains:
   - `specs/architecture/`: Evergreen system-level designs. Keep up-to-date when architecture changes.
   - `specs/features/`: Evergreen functional domain behaviors. Keep up-to-date when features evolve.
   - `specs/proposals/`: Point-in-time ADRs (Architecture Decision Records), refactoring plans, and design drafts. May be outdated — do not blindly trust. Always verify against current code. Evergreen docs must not cite proposals; hoist durable rules into the relevant evergreen doc.

## Project Structure

Meepo is a monorepo managed by [Moon](https://moonrepo.dev/) and [pnpm](https://pnpm.io/) workspaces.

```
meepo/
  apps/
    meepo-server/          # Central control plane: Feishu gateway, space/session manager, dispatcher, ticket queue
    meepo-worker/          # Distributed execution runner: git worktree management, Pi runtime execution
    meepo-console/         # Admin console (Vite + React)
  packages/
    core/                  # Shared domain entities (Space, Worker, Ticket, Session, Memory, Slot)
    protocol/              # Wire envelopes, event schemas, RPC contracts, streaming frames
    sdk/                   # Client SDK for programmatic worker interaction & extensions
  specs/                   # Architecture, feature, and proposal docs
```

### Architecture References

| Component / Subsystem | Role | Spec |
|---|---|---|
| System Overview | End-to-end architecture & topology | `specs/architecture/system-overview.md` |
| Server Control Plane | Gateway, Dispatcher, Memory & Session Store | `specs/architecture/server-control-plane.md` |
| Worker Data Plane | Runner lifecycle, Slot concurrency, Worktree | `specs/architecture/worker-data-plane.md` |
| Space & Chat Mapping | Multi-chat to Space isolation model | `specs/features/space-and-chat.md` |
| Interactive Session | Real-time Thread routing & streaming | `specs/features/interactive-session.md` |
| Ticket Pipeline | Async task & batch run pipeline | `specs/features/ticket-pipeline.md` |

## Coding Style & Guard Rails

### TypeScript

- Strict TypeScript (`strict: true`, Node strip-only or modern bundler module resolution).
- Formatting: Prettier (`.prettierrc.json`).
- Linting: ESLint with `typescript-eslint`.
- No `any` unless strictly justified at serialization boundaries.
- No dynamic / inline imports (`import()`) in shared core packages unless lazy-loading provider SDKs.
- Top-level named exports preferred.

### Architecture Constraints

- **Single Source of Truth (SST)**: `meepo-server` owns persistent configuration, space long-term memory, and authoritative session transcripts. `meepo-worker` is a disposable computation runner and must remain stateless across task lifetimes.
- **Slot Isolation**: A worker's slot defines its maximum concurrency limit. When `slot > 1`, tasks MUST run in isolated `git worktree` directories to prevent file collisions.
- **Clean Worker Context**: Workers executing coding tasks must receive structured objective bundles rather than uncurated conversational chat logs.
- **Protocol Independence**: Payloads between server and worker must conform to `@meepo/protocol` contracts and serialize cleanly to JSON/CBOR.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org/) format (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- Keep subject line concise and informative, focusing on architectural intent.
- Do not commit directly unless explicitly instructed by the user.
