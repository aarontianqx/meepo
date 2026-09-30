# MEEPO v2 Implementation Plan

Status: Approved baseline for v2 development (2026-09-30). Supersedes v1 implementation wherever they conflict.

**Authority order**: evergreen specs (target design) → this plan (sequencing & acceptance) → code (current reality). Decision rationale lives in `20260928-meepo-v2-design-brainstorm.md` by decision id (`D*`) — consult it for *why*, never for sequencing.

## 0. How to Use This Document

- This plan is the single entry point for v2 development. Each work item (`W#`) lists its contract sources, the gap vs v1, and its Definition of Done (DoD).
- Specs are normative; this plan never restates spec content, it points at it. If a restatement seems necessary, fix the spec first.
- If implementation reveals a contradiction with a decision or spec, **stop and escalate** — do not improvise. Record the conflict in `specs/proposals/blockers/<date>-W#-<slug>.md` (conflicting clauses, options, your lean), suspend the affected item, and continue with non-blocked items; stop only when everything remaining is blocked.
- Code changes and the evergreen docs describing them land **in the same commit**.

## 1. Scope

**In scope (v2)**: execution-contract unification, reliability semantics, memory system, prompt skeleton + domain presets, console observability, input scope (text / quoted text / images), ticket observability, worker-side MCP, multi-channel registry completion. Feishu is the only IM channel implemented.

**Out of scope (deferred, with trigger conditions)**:

| Item | Trigger to revisit |
| --- | --- |
| Horizontal scale-out | After Postgres migration; requires connection-ownership + shared-queue protocol |
| Vector memory search | When a stable embedding model is available (`embedding` column reserved) |
| Webhook endpoint (minimal) | Delivered as W10 (last item); any broader open API stays deferred |
| Permission / approval modes | Rejected for v2 (D12-48); revisit only on real incidents |
| File attachments / rich-text input | User demand |
| Second IM channel (Telegram/Slack) | Real demand; schema already reserved |
| Identity-aware routing policy | Real demand; hook reserved in the dispatcher |

## 2. Work Items

Dependency chain: `W0 → W0b → W1 → W2/W3 → W4 → W5/W6 → W7 → W9 → W10`. W2/W3 and W5/W6 are parallelizable pairs.

Status (updated at each completion — progress survives interruption):

| Work item | Status | Date |
| --- | --- | --- |
| W0 | Not started | — |
| W0b | Not started | — |
| W1 | Not started | — |
| W2 | Not started | — |
| W3 | Not started | — |
| W4 | Not started | — |
| W5 | Not started | — |
| W6 | Not started | — |
| W7 | Not started | — |
| W9 | Not started | — |
| W10 | Not started | — |

### W0 — Contract Unification (foundation, blocks everything)

- **Contract**: D11-32, D11-34, D13-51; `specs/features/triggers-and-scheduling.md` §4–5; `specs/architecture/server-control-plane.md` §3.
- **Gap vs v1**: v1 has `Run` but no `turnRef` / `leaseExpiresAt` / `merged` / `dropped`; events persist at turn boundaries instead of transactional segments; no `seq`-based recovery; no `context.append` hot-session sync.
- **DoD**: protocol + core + server carry the v2 Run and event schemas; segment persistence with crash recovery by last confirmed `seq`; hot-session append for server-side writes; breaking migration via the migration framework without data wipe (D11-44); `worker-protocol.md` completed (field-level RPC inventory, `protocolVersion` register guard); test infrastructure — four fakes (`FakeFeishuChannel`, scripted model provider, in-process worker with disconnect simulation, injectable clock); minimal CI guardrails (ESLint `no-restricted-imports` + CI workflow running lint/test/build).

### W0b — Channel Foundation

- **Contract**: D11-38, D11-36, D13-56; `specs/features/space-and-chat.md` §1–2.
- **Gap vs v1**: v1 has no ChannelRegistry — Feishu credentials are global env config; private chats resolve via a global default space; group chats are gated by `boundChatIds`. W0b builds the channel subsystem from scratch.
- **DoD**: ChannelRegistry created (`{ type, appId, appSecret }`); env credentials auto-convert into a registry entry bound to the space named by `MEEPO_DEFAULT_SPACE_ID` (skipped with a warning when unset), idempotent across restarts; new `windowId` format `{channelId}:{chat_id}:{sub_id}` with migration of existing window→session mappings; gateway manages one long connection per channel at runtime with channelId-keyed caches; private chats resolve via the channel (optional `allowedOpenIds`), group chats gated by `{channelId, chatId}` bound pairs; credential rotation reconnects only the affected channel.

### W1 — Execution Reliability

- **Contract**: D11-33, D11-39, D13-51; `specs/features/ticket-pipeline.md` §5; `specs/features/triggers-and-scheduling.md` §2 (Boundary Rules).
- **Gap vs v1**: on worker disconnect v1 only updates the worker's status; in-flight tickets are stranded until a manual `requeue` API call — there is no automatic recovery chain, no lease, no late-result rejection, no `manual_review`; fire → work-item creation is not atomic; schedule boundary rules unimplemented.
- **DoD**: lease-based re-dispatch; expired-attempt results rejected; non-retryable side-effecting work parks in `manual_review`; schedule fire and work-item creation commit in one transaction; boundary rules (timezone, `at` catch-up, jitter, `/new` cascade, 50-schedule cap, stale renewal) enforced.

### W2 — Memory System

- **Contract**: D12-50, D13-53, D13-59; `specs/features/memory.md`; `specs/architecture/server-control-plane.md` §2; `specs/architecture/worker-data-plane.md` §5.
- **Gap vs v1**: v1 has a single `longTermMemory` blob; no entries, no tools, no console page. No data migration needed (blob is unused) — direct replacement (D11-44).
- **DoD**: entry schema with `revision` (tombstone deletion); trigram FTS5 retrieval with `LIKE` fallback for short queries; five server APIs + five worker proxy tools with `expected_revision`; directory-level Memory Map rendered at session creation, appended at the end of the system prompt with the staleness disclaimer; console Memory page; contract details per `specs/features/memory.md`.

### W3 — Prompt Skeleton & Domain Presets

- **Contract**: D9-24, D11-35; `specs/architecture/worker-data-plane.md` §3.
- **Gap vs v1**: v1 prompt is monolithic; no preset split; no snapshot persistence; time handling not cache-aware; `~/.agents/AGENTS.md` and skill descriptions are not loaded by the worker (D12-48 relies on them for behavior rules).
- **DoD**: two-level rendering (server: identity/space; worker: environment/skills); universal skeleton free of git assumptions; coding preset (worktree discipline) opt-in per space; prompt snapshot persisted at session creation; current time carried per-turn in the turn envelope, not the frozen prompt; worker loads `~/.agents/AGENTS.md` and `~/.agents/skills/` descriptions at render, refreshed at cold start; Memory Map rendered as a separately versioned suffix block.

### W4 — Console Observability

- **Contract**: D11-42, D7-16, D11-44; `specs/architecture/server-control-plane.md` §7–8 (Channels page depends on W0b).
- **Gap vs v1**: v1 console covers Spaces/Workers/Tickets/Models basics; no transcript viewer, no mailbox injection, no Schedules/Sessions/Memory pages; membership still uses the `manager` role and there is no global admin.
- **DoD**: full page list; transcript snapshot + WebSocket increments with `seq` resume; mailbox injection as `system_note` with `wait` delivery, member-only; `manager → operator` rename via the migration framework; global `admin` role enforced for the Models/Channels registry pages; enrollment token management (list / issue / revoke) on the space page.

### W5 — Input Scope & Card Contract

- **Contract**: D12-47, D11-41; `specs/features/interactive-session.md` §3 (Input Scope) and §7; `specs/architecture/server-control-plane.md` §5.
- **Gap vs v1**: v1 handles text only; the streaming card has a stop button but no tool pills, no scroll-card rotation for long content, and no sequence-ordered update queue.
- **DoD**: `quoted_message` block (sender + body) in agent context for replies; images downloaded via Feishu API, delivered as `ImageContent`, transcript stores file references only; card contract complete — tool pills, scroll-card rotation past the length cap, monotonic `sequence` with per-run serial updates, no-card-without-content, stop permission limited to the turn initiator.

### W6 — Ticket Observability

- **Contract**: D12-49; `specs/features/ticket-pipeline.md` §3.
- **Gap vs v1**: ticket runs persist only status + result; execution is a black box.
- **DoD**: ticket run event stream persisted (delta types filtered), keyed by `ticketId + attempt`; console ticket detail page renders the tool trace and final text; origin session transcript receives only the receipt event.

### W7 — Worker Config & MCP

- **Contract**: D12-46, D11-43; `specs/architecture/worker-data-plane.md` §3.
- **Gap vs v1**: no MCP support; worker configuration is env-only with no file format.
- **DoD**: worker config file format documented (slots, tags, model defaults, `[mcp]` section) with env overrides for common keys; MCP stdio + remote connections lifecycle-bound to the worker; tools namespaced `mcp__<server>__<tool>`; hot-reload with keep-old-on-error, effective for new sessions and cold-starts only (warm sessions keep their tool set); tool availability identical between sessions and tickets (orchestration tools excepted).

### W9 — Postgres Migration

- **Contract**: D11-37; `specs/architecture/server-control-plane.md` §1.
- **Gap vs v1**: SQLite only.
- **DoD**: store layer ported behind existing ports; SQLite remains the dev default; migration path documented. Prerequisite for any future scale-out work.

### W10 — Webhook Route (Reserved)

- **Contract**: D10-28; `specs/features/ticket-pipeline.md` §4.
- **DoD**: reserved inbound route that materializes external events as tickets, behind auth; no open API surface beyond it.

## 3. Cross-Module Acceptance Scenarios

Acceptance runs in two layers with different purposes:

- **Automated integration tests** (fakes, in-repo, CI-runnable) guard against regression. Every scenario below is implemented as a deterministic test with preconditions, steps, and assertions.
- **Real-Feishu functional verification** (the test group) confirms features actually work. Each W is verified in the real group before it is called done — driven by whoever holds the credentials.

| # | Layer | Scenario | Expected (contract source) |
| --- | --- | --- | --- |
| 1 | Auto | Feishu redelivers an event; server restarts mid-processing | No duplicate session, work item, or reply (durable dedup + `seq` recovery) — W0 |
| 2 | Real | Three messages arrive while busy, then the user presses stop | Merge rules applied; every run reaches exactly one terminal state; stop targets the active run — W0/W3 |
| 3 | Auto | Worker disconnects mid-ticket but the agent process stays alive | Re-dispatch only after lease expiry; late result rejected; side-effecting work parks in `manual_review` — W1 |
| 4 | Auto | Server crashes between schedule-fire record and work-item creation | Atomic creation: no lost fire, no unidentifiable duplicate — W1 |
| 5 | Auto | Rebind the space and `/new` while a turn is running | Old run, queued messages, schedules (cascade-delete `resume_session`), and cards all reach their defined fates — W0/W1 |
| 6 | Auto | Console edits memory while a ticket receipt lands in a live session | Hot session receives `context.append`; cold-start and warm sessions see consistent context — W0/W2 |
| 7 | Real | Two bots in one group; one worker shared by two spaces | Routing, RPC, transcripts, and logs stay isolated per space/channel contract — W0b |
| 8 | Auto | Worker restarts right after a tool execution | Recovered context preserves `toolCallId` pairing; recovered tool calls with unknown outcomes enter their defined state (no blind repeat) — W0 |

Real-environment verification additionally covers: quoted-message rendering in agent context, image ingestion, card contract (tool pills, scroll-card, stop permission), and reconnect resume.

## 4. Decision Traceability

Theme-level mapping from decisions to their spec home, owning work item, and acceptance scenario. Every v2 decision must appear here; if a row is missing, the decision has no implementation path.

| Decision cluster | Spec home | Work item | Acceptance |
| --- | --- | --- | --- |
| Execution model: Turn/Run identity, merge, terminal states (D11-32, D13-51) | triggers-and-scheduling §4–5; interactive-session §5–6 | W0 | S1, S2 |
| SST persistence, event dedup, channel separation (D11-34, D13-51) | server-control-plane §3 | W0 | S1, S5, S6, S8 |
| Ticket retry, lease, manual_review (D11-33, D13-51) | triggers-and-scheduling §3; ticket-pipeline §5 | W1 | S3 |
| Schedule boundary rules (D11-39) | triggers-and-scheduling §2 | W1 | S4 |
| Rebind & `/new` behavior (D11-31, D12-45) | interactive-session §2 | W1 | S5 |
| Memory system (D12-50, D9-22, D9-25) | server-control-plane §2; worker-data-plane §5 | W2 | S6 |
| Prompt skeleton, presets, effective timing (D9-24, D11-35) | worker-data-plane §3 | W3 | S2, S6 |
| Console, roles, membership (D11-42, D7-16, D11-44) | server-control-plane §7–8 | W4 | S6 |
| Input scope & card contract (D12-47, D11-41) | interactive-session §3, §7; server-control-plane §5 | W5 | S2, S7 |
| Ticket observability (D12-49) | ticket-pipeline §3 | W6 | S3 |
| Worker config & MCP (D12-46, D11-43) | worker-data-plane §3 | W7 | — |
| Channels & chat gating (D11-38, D11-36, D13-56) | space-and-chat §1–2 | W0b | S7 |
| Topology: single control plane (D11-37) | server-control-plane §1 | W9 | — |
| Webhook route (D10-28) | ticket-pipeline §4 | W10 | — |
| Worker protocol & version guard (D13-59) | worker-protocol.md | W0 | S1, S8 |
| Memory contract details (D13-59) | memory.md | W2 | S6 |
| Interaction details: pills, errors, urgent, commands (D13-59) | interactive-session §6–7; server-control-plane §5 | W5 | S2 |
| Retention & usage (D13-59) | server-control-plane §3; worker-data-plane §2; triggers-and-scheduling §5 | W0 | — |
| Test infrastructure & CI guardrails (D13-60) | — (repo tooling) | W0 | all auto scenarios |
| workerId binding (D13-60) | worker-data-plane §1 | W0b | S7 |
| Slot semantics (D13-60) | system-overview §2 | W1 | S2 |

## 5. Implementation-Time Decision Points

Small deferred items to decide when the touching work item starts (record outcomes as new D-rows):

- Worker-offline group notice: silent queue vs. one "queued" notice per window (touches W0).
- Per-channel bot display naming when a space has multiple channels (touches W8).

## 6. Global Definition of Done

- `pnpm build` and the project's test suite are green on the deliverable itself.
- All scenarios pass as automated integration tests in CI; each W's real-Feishu functional verification is completed.
- Evergreen specs and `AGENTS.md` accurately describe the merged behavior; this plan's gap column is empty in fact, not just in text.
