# Backend Layering Conventions

These conventions govern `meepo-server` and any future heavy backend in this monorepo. They are enforceable rules, not style suggestions — the dependency rule is enforced mechanically (ESLint, with a CI workflow configured).

## Layers

- **`transport/`** — the edges: HTTP routes, WebSocket channels, Feishu ingress. Parses, validates, and serializes. Contains no business decisions and never touches stores directly.
- **`domain/`** — business logic, organized by aggregate (`spaces/`, `workers/`, `sessions/`, `tickets/`, `dispatch/`, `schedule/`). Must not import `transport/` or transport frameworks (`fastify`, `ws`, lark SDK). Ports (repository and service interfaces) are defined here, next to their consumer.
- **`store/`** — persistence adapters implementing domain ports. New cross-entity transaction methods use an explicit `Tx` prefix. Existing `SqliteTicketRepository.save()` is an exception: it also fences runs and enqueues receipts for terminal tickets; its exact contract is documented in [server control plane](server-control-plane.md). Do not replace it with a row-only save when changing adapters.
- **`infra/`** — cross-cutting technical mechanisms: config, logging, auth adapters, ID generation, throttling. One subpackage per topic. Holds no business semantics (those belong in `domain/`); a catch-all `utils`/`common` module is forbidden.

Call flow: `transport → domain → persistence ports`. Store adapters implement domain ports; domain code must not import concrete stores. The composition root supplies them. `infra` may be used by any layer but depends on none of them.

## Placement Rules

- Ports are defined by the consumer, never by the implementer.
- Cross-aggregate calls go through narrow interfaces declared by the consumer, preserving seams for future service splits.
- Shared entities live in `@meepo/core`; server-internal models stay inside the server.
- A symbol is promoted into `packages/` only when it has multiple real consumers.
- Identity is read from request context; it is never accepted from request payloads.

## Composition

- All wiring lives in a single composition root (`bootstrap.ts`), assembled manually.
- Constructor injection only — no setter wiring, no package-level singletons. Anything a test may need to fake (stores, config, clock) is injectable.

## Errors

- Domain errors carry stable codes; the transport layer maps them to HTTP statuses and RPC error bodies. Some domains add structured detail (for example memory revision conflicts).
- Expected business errors are not logged at the throw site; middleware logs them once.

## Enforcement

- ESLint `no-restricted-imports` encodes the dependency rule (e.g. `domain/` cannot import `transport/` or transport frameworks); the repository includes a workflow running lint/test/build. This rule covers domain imports; constructor wiring and cross-entity transaction semantics also require code review and integration tests.
