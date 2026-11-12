# Backend Layering Conventions

> **Scope**: Establishes the structural dependency rules, port ownership discipline, composition root pattern, and error-mapping boundaries for `meepo-server` and any stateful backend service in Meepo.

## 1. Architectural Layers and Dependency Direction

Backend code is organized into four strict layers with one-way dependencies:

```text
transport/  ──calls──►  domain/ (business logic + consumer-defined ports)  ◄──implements──  store/
   │                       │                                                                   │
   └───────────────────────┴──────────────────────► infra/ ◄───────────────────────────────────┘
```

1. **`transport/` (Edges)**: HTTP routes, WebSocket handlers, and IM provider gateways/streamers. Parses wire frames, authenticates/authorizes requests, invokes domain services, and maps domain results or errors to wire responses. Contains **no business rules** and never accesses `store/` directly.
2. **`domain/` (Core Business Logic)**: Organized by domain aggregate (`spaces/`, `channels/`, `models/`, `memberships/`, `enrollments/`, `workers/`, `sessions/`, `prompts/`, `memory/`, `tickets/`, `schedule/`, `dispatch/`, `runs/`, `im/`, `webhooks/`, `outbound/`). Owns all state transitions, validation invariants, and **port interfaces** (repositories, transactional committers, outbound senders). `domain/` must never import `transport/`, `store/`, HTTP/WebSocket frameworks, or IM provider SDKs.
3. **`store/` (Persistence Adapters)**: Concrete database implementations of domain persistence ports. Cross-entity atomic operations are exposed as explicit transactional port methods (prefixed with `Tx`, such as `TxEnqueueTurn`, `TxClaimTicket`, `TxAppend`, `TxFire`, `TxReset`, `TxRebind`, `TxClose`, `TxWrite`, `TxDelete`) so multi-entity atomicity is enforced inside a single database transaction without leaking SQL or storage primitives into `domain/`.
4. **`infra/` (Cross-Cutting Mechanisms)**: Pure technical utilities with zero business semantics — secret encryption (`SecretCodec`), identity extraction adapters (`HeaderAuthenticator`), throttling, or structured logging. One focused module per mechanism; catch-all `utils` or `common` buckets are forbidden. `infra/` depends on none of the other three layers.

_Rationale: Enforcing consumer-owned ports in `domain/` keeps domain logic deterministic and fast to test, prevents transport quirks (e.g., Feishu SDK types or HTTP headers) from contaminating core state machines, and preserves clean seams for swapping storage engines (e.g., SQLite to PostgreSQL) or splitting services._

## 2. Port Ownership, Package Boundaries, and Identity

- **Consumer-defined ports**: Interfaces are declared next to the domain service that consumes them, never in the adapter package that implements them. Cross-aggregate collaboration uses narrow interfaces rather than passing broad concrete repositories.
- **Shared package promotion**: A type belongs in `@meepo/core` or `@meepo/protocol` only when genuinely shared across multiple applications (`meepo-server`, `meepo-worker`, `meepo-console`). Server-internal projections, committers, and outbox schemas stay inside `meepo-server`.
- **Context-bound identity**: User identity enters solely through the `Authenticator` port on the transport request context and is passed explicitly into domain methods when attribution or ownership checks apply; domain inputs never trust identity fields inside client payloads.

## 3. Composition and Error Boundaries

- **Single manual composition root**: Dependency wiring happens in a single bootstrap module (`bootstrap.ts`) using **constructor injection only** — no service locators, no mutable setter injection, and no module-level stateful singletons. Clocks (`now`), stores, and outbound senders are injectable so time-sensitive leases, retries, and schedules can be tested deterministically.
- **Domain error mapping**: Domain services throw typed `DomainError` instances carrying stable semantic codes (`validation`, `unauthorized`, `not_found`, `conflict`, plus structured domain subtypes such as `MemoryError` with `currentRevision`). Expected business errors are not logged at the throw site; transport error handlers map them once to HTTP status codes or RPC error bodies and log unexpected internal failures centrally.

## 4. Current Implementation Notes (TypeScript Monorepo)

- **Mechanical import enforcement**: Root `eslint.config.mjs` enforces `no-restricted-imports` on `apps/meepo-server/src/domain/**/*.ts`, failing CI (`pnpm check`) if domain modules import `transport/`, `store/`, `fastify`, `@fastify/*`, `ws`, or `@larksuiteoapi/*`.
- **Transactional ticket save**: While newer multi-entity operations use explicit `Tx*` port methods, `SqliteTicketRepository.save()` also atomically fences related non-terminal runs and enqueues origin receipts when saving a terminal ticket (`completed`, `failed`, `cancelled`). Any future storage adapter (such as PostgreSQL) or port refactor must preserve that exact multi-entity atomicity contract (see [Server Control Plane](server-control-plane.md#transaction-boundaries-and-cancellation-contract)).
