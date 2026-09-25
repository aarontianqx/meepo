# Backend Layering Conventions

These conventions govern `meepo-server` and any future heavy backend in this monorepo. They are enforceable rules, not style suggestions — the dependency rule is checked in CI.

## Layers

- **`transport/`** — the edges: HTTP routes, WebSocket channels, Feishu ingress. Parses, validates, and serializes. Contains no business decisions and never touches stores directly.
- **`domain/`** — business logic, organized by aggregate (`spaces/`, `workers/`, `sessions/`, `tickets/`, `dispatch/`, `schedule/`). Must not import `transport/` or transport frameworks (`fastify`, `ws`, lark SDK). Ports (repository and service interfaces) are defined here, next to their consumer.
- **`store/`** — persistence adapters implementing domain ports. Transactional methods carry an explicit `Tx` prefix so transaction participation is visible in the signature.
- **`infra/`** — cross-cutting technical mechanisms: config, logging, auth adapters, ID generation, throttling. One subpackage per topic. Holds no business semantics (those belong in `domain/`); a catch-all `utils`/`common` module is forbidden.

Dependency rule: `transport → domain → store`, one-way. `infra` may be used by any layer but depends on none of them.

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

- Domain errors carry a stable, domain-segmented code; the transport layer maps codes to HTTP statuses and RPC error bodies.
- Expected business errors are not logged at the throw site; middleware logs them once.

## Enforcement

- ESLint `no-restricted-imports` encodes the dependency rule (e.g. `domain/` cannot import `transport/` or transport frameworks). Conventions that CI cannot check do not belong in this document.
