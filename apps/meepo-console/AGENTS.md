# Meepo Console -- Agent Guidelines

Applies to `apps/meepo-console`; the repository-wide rules in the root `AGENTS.md` also apply.

- **Layout**: `meepo-console/src` is `app/` (shell, router, space context), `features/<section>/` (one folder per sidebar section), `ui/` (design-system primitives), `api/` (typed client, `endpoints.ts`, shared query cache), `lib/` (pure helpers), and `styles/` (tokens first). Add no runtime dependencies; talk to the server only through `api/endpoints.ts`; keep user-facing text in product vocabulary (Conversations, Tickets, Workers) and keep pure logic in `lib/` or colocated `*.test.ts`-covered modules.
