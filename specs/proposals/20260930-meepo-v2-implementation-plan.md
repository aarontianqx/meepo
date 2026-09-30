# MEEPO v2 Implementation Plan

Status: Approved baseline for v2 development (2026-09-30). Supersedes v1 implementation wherever they conflict.

**Authority order**: evergreen specs (target design) → this plan (sequencing & acceptance) → code (current reality). Decision rationale lives in `20260928-meepo-v2-design-brainstorm.md` by decision id (`D*`) — consult it for *why*, never for sequencing.

## 0. How to Use This Document

- This plan is the single entry point for v2 development. Each work item (`W#`) lists its contract sources, the gap vs v1, and its Definition of Done (DoD).
- Specs are normative; this plan never restates spec content, it points at it. If a restatement seems necessary, fix the spec first.
- If implementation reveals a contradiction with a decision or spec, **stop and escalate** — do not improvise. Decisions change only through the brainstorm process, recorded as new D-rows.
- Code changes and the evergreen docs describing them land **in the same commit**.

## 1. Scope

**In scope (v2)**: execution-contract unification, reliability semantics, memory system, prompt skeleton + domain presets, console observability, input scope (text / quoted text / images), ticket observability, worker-side MCP, multi-channel registry completion. Feishu is the only IM channel implemented.

**Out of scope (deferred, with trigger conditions)**:

| Item | Trigger to revisit |
| --- | --- |
| Horizontal scale-out | After Postgres migration; requires connection-ownership + shared-queue protocol |
| Vector memory search | When a stable embedding model is available (`embedding` column reserved) |
| Webhook / open API | Real external integration demand (route reserved in W10) |
| Permission / approval modes | Rejected for v2 (D12-48); revisit only on real incidents |
| File attachments / rich-text input | User demand |
| Second IM channel (Telegram/Slack) | Real demand; schema already reserved |
| Identity-aware routing policy | Real demand; hook reserved in the dispatcher |

## 2. Work Items

Dependency chain: `W0 → W1 → W2/W3 → W4 → W5/W6 → W7 → W8 → W9 → W10`. W2/W3 and W5/W6 are parallelizable pairs.

### W0 — Contract Unification (foundation, blocks everything)

- **Contract**: D11-32, D11-34; `specs/features/triggers-and-scheduling.md` §4–5; `specs/architecture/server-control-plane.md` §3.
- **Gap vs v1**: v1 has `Run` but no `turnRef` / `leaseExpiresAt` / `merged` / `dropped`; events persist at turn boundaries instead of transactional segments; no `seq`-based recovery; no `context.append` hot-session sync.
- **DoD**: protocol + core + server carry the v2 Run and event schemas; segment persistence with crash recovery by last confirmed `seq`; hot-session append for server-side writes; breaking migration via the migration framework without data wipe (D11-44).

### W1 — Execution Reliability

- **Contract**: D11-33, D11-39; `specs/features/ticket-pipeline.md` §5; `specs/features/triggers-and-scheduling.md` §2 (Boundary Rules).
- **Gap vs v1**: v1 resets disconnected tickets to `pending` immediately; no lease, no late-result rejection, no `manual_review`; fire → work-item creation not atomic; schedule boundary rules unimplemented.
- **DoD**: lease-based re-dispatch; expired-attempt results rejected; non-retryable side-effecting work parks in `manual_review`; schedule fire and work-item creation commit in one transaction; boundary rules (timezone, `at` catch-up, jitter, `/new` cascade, 50-schedule cap, stale renewal) enforced.

### W2 — Memory System

- **Contract**: D12-50; `specs/architecture/server-control-plane.md` §2; `specs/architecture/worker-data-plane.md` §5.
- **Gap vs v1**: v1 has a single `longTermMemory` blob; no entries, no tools, no console page. No data migration needed (blob is unused) — direct replacement (D11-44).
- **DoD**: entry schema with `revision`; FTS5 retrieval; five server APIs + five worker proxy tools with `expected_revision`; directory-level Memory Map rendered at session creation, appended at the end of the system prompt with the staleness disclaimer; console Memory page.

### W3 — Prompt Skeleton & Domain Presets

- **Contract**: D9-24, D11-35; `specs/architecture/worker-data-plane.md` §3.
- **Gap vs v1**: v1 prompt is monolithic; no preset split; no snapshot persistence; time handling not cache-aware.
- **DoD**: two-level rendering (server: identity/space; worker: environment/skills); universal skeleton free of git assumptions; coding preset (worktree discipline) opt-in per space; prompt snapshot persisted at session creation; current time carried per-turn in the turn envelope, not the frozen prompt.

### W4 — Console Observability

- **Contract**: D11-42; `specs/architecture/server-control-plane.md` §8.
- **Gap vs v1**: v1 console covers Spaces/Workers/Tickets/Models basics; no transcript viewer, no mailbox injection, no Schedules/Sessions/Memory pages.
- **DoD**: full page list; transcript snapshot + WebSocket increments with `seq` resume; mailbox injection as `system_note` with `wait` delivery, member-only.

### W5 — Input Scope

- **Contract**: D12-47; `specs/features/interactive-session.md` §3 (Input Scope).
- **Gap vs v1**: v1 handles text only.
- **DoD**: `quoted_message` block (sender + body) in agent context for replies; images downloaded via Feishu API, delivered as `ImageContent`, transcript stores file references only.

### W6 — Ticket Observability

- **Contract**: D12-49; `specs/features/ticket-pipeline.md` §3.
- **Gap vs v1**: ticket runs persist only status + result; execution is a black box.
- **DoD**: ticket run event stream persisted (delta types filtered), keyed by `ticketId + attempt`; console ticket detail page renders the tool trace and final text; origin session transcript receives only the receipt event.

### W7 — Worker-Side MCP

- **Contract**: D12-46, D11-43; `specs/architecture/worker-data-plane.md` §3.
- **Gap vs v1**: no MCP support.
- **DoD**: `[mcp]` section in the worker config file (stdio + remote); processes lifecycle-bound to the worker; tools namespaced `mcp__<server>__<tool>`; config hot-reload with keep-old-on-error; tool availability identical between sessions and tickets.

### W8 — Channel Registry Completion

- **Contract**: D11-38, D11-36; `specs/features/space-and-chat.md` §1–2.
- **Gap vs v1**: v1 has a single channel per space (`boundChannelId`) and no per-space chat gating.
- **DoD**: `boundChannelIds` (plural); per-space `boundChatIds` gates which chats the bot responds in (unbound chats stay silent); env-provided Feishu credentials auto-convert into a ChannelRegistry entry (D11-44).

### W9 — Postgres Migration

- **Contract**: D11-37; `specs/architecture/server-control-plane.md` §1.
- **Gap vs v1**: SQLite only.
- **DoD**: store layer ported behind existing ports; SQLite remains the dev default; migration path documented. Prerequisite for any future scale-out work.

### W10 — Webhook Route (Reserved)

- **Contract**: D10-28; `specs/features/ticket-pipeline.md` §4.
- **DoD**: reserved inbound route that materializes external events as tickets, behind auth; no open API surface beyond it.

## 3. Cross-Module Acceptance Scenarios

Every scenario must pass end-to-end against the real Feishu test group before v2 is called done:

| # | Scenario | Expected (contract source) |
| --- | --- | --- |
| 1 | Feishu redelivers an event; server restarts mid-processing | No duplicate session, work item, or reply (dedup + `seq` recovery) — W0 |
| 2 | Three messages arrive while busy, then the user presses stop | Merge rules applied; every run reaches exactly one terminal state; stop targets the active run — W0/W3 |
| 3 | Worker disconnects mid-ticket but the agent process stays alive | Re-dispatch only after lease expiry; late result rejected; side-effecting work parks in `manual_review` — W1 |
| 4 | Server crashes between schedule-fire record and work-item creation | Atomic creation: no lost fire, no unidentifiable duplicate — W1 |
| 5 | Rebind the space and `/new` while a turn is running | Old run, queued messages, schedules (cascade-delete `resume_session`), and cards all reach their defined fates — W0/W1 |
| 6 | Console edits memory while a ticket receipt lands in a live session | Hot session receives `context.append`; cold-start and warm sessions see consistent context — W0/W2 |
| 7 | Two bots in one group; one worker shared by two spaces | Routing, RPC, transcripts, and logs stay isolated per space/channel contract — W8 |
| 8 | Worker restarts right after a tool execution | Recovered context preserves `toolCallId` pairing; no blind repeat of side-effecting calls — W0 |

## 4. Implementation-Time Decision Points

Small deferred items to decide when the touching work item starts (record outcomes as new D-rows):

- Worker-offline group notice: silent queue vs. one "queued" notice per window (touches W0).
- Enrollment token lifecycle: revocation / expiry / rotation rules (touches W8).
- Per-channel bot display naming when a space has multiple channels (touches W8).
- Stale-schedule renewal UX: how the model confirms continuation at 7 days (touches W1).

## 5. Global Definition of Done

- `pnpm build` and the project's test suite are green on the deliverable itself.
- All eight acceptance scenarios pass against the real environment.
- Evergreen specs and `AGENTS.md` accurately describe the merged behavior; this plan's gap column is empty in fact, not just in text.
