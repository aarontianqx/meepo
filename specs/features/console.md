# Feature: Management Console

> **Scope**: Specifies the functional surfaces, role-based capabilities, live transcript observation workflow, emergency mailbox injection, ticket manual-review resolution, and optimistic conflict handling of `meepo-console`. Endpoint wire contracts live in [Control Plane API](../architecture/control-plane-api.md).

## 1. Purpose and Explicit Non-Goals

`meepo-console` is a single-page web application (served directly by `meepo-server`) providing **configuration management, execution observability, and operational intervention** across Spaces, Workers, Tickets, Sessions, Schedules, Memory, Models, and Channels.

- **Not a Web IM**: Primary human-agent collaboration happens inside IM channels (Feishu). The Console intentionally omits rich multi-turn chat composer features (threads, image uploads, streaming markdown cards), offering only a bounded **Mailbox** injection input on existing sessions for administrative nudges or recovery.
- **No read-only viewer role**: Because conversing with a bot in IM requires zero Console access, Console visibility is aligned 1:1 with operational responsibility — every Space member (`owner` or `operator`) can inspect and administer that Space, while non-members cannot see the Space at all.

## 2. Role Capability Matrix

| Surface / Action                                                 | Space `operator` | Space `owner` | Global `admin` (non-member) |
| ---------------------------------------------------------------- | :--------------: | :-----------: | :-------------------------: |
| Create a new Space (becomes initial `owner`)                     |        ✓         |       ✓       |              ✓              |
| View/edit Space settings, preset, model (`model-options`), chats |        ✓         |       ✓       |              —              |
| Switch Space `boundWorkerId` (triggers `main` rebind)            |        ✓         |       ✓       |              —              |
| Issue/revoke enrollment tokens & rotate/revoke webhook token     |        ✓         |       ✓       |              —              |
| View Space usage totals, Workers, Sessions, Schedules, Memory    |        ✓         |       ✓       |              —              |
| Inject Session mailbox note, stop active Run, close Session      |        ✓         |       ✓       |              —              |
| Create/cancel Ticket; Retry (`requeue`) or Abandon review        |        ✓         |       ✓       |              —              |
| Add Space members (`operator`)                                   |        ✓         |       ✓       |              —              |
| Remove Space member, transfer ownership, or **Delete Space**     |        —         |       ✓       |              —              |
| Manage global **Models** and **Channels** registries             |        —         |       —       |              ✓              |

In development mode (`HeaderAuthenticator`), the top bar exposes a **User** identity input persisted in `localStorage` (`meepo.userId`) and sent as `x-meepo-user-id`; changing the active user remounts the view tree so all queries refetch under the new principal immediately. A live health indicator polls `GET /healthz` every `10s`.

## 3. Navigation Surfaces and Workflows

### 3.1 Spaces & Space Detail

- **Spaces list**: Lists all spaces where the user is a member and provides a creation form (`name`, optional `repoUrl`, `defaultBranch`, `description`, `timezone`, `requiredTags`).
- **Space Detail**: Central administration hub for a single space:
  - **Overview & Usage**: Displays space metadata alongside aggregated provider token/cost usage (`reportedRunCount / runCount` coverage; unreported costs are never shown as `$0.00`).
  - **Prompt Preset & Model**: Selects `general` vs. `coding` preset (noting existing sessions keep their frozen preset) and binds a model from credential-free `GET /api/model-options` plus optional `thinkingLevel` (`low` / `high` / `max`).
  - **Worker Binding**: Switches `boundWorkerId` among workers enrolled for the space, warning that active `main` sessions will interrupt and migrate while `thread` sessions stay pinned.
  - **Allowed Group Chats**: Edits `boundChatIds` per channel assigned to the space (`PUT /api/spaces/:id/channels/:channelId/chats`).
  - **Members & Ownership**: Lists members, adds `operator`s, and (for `owner`s) removes members, transfers ownership, or deletes the space.
  - **Enrollment & Webhook Credentials**: Issues multi-space or single-space worker enrollment tokens (displaying plaintext once with revocation controls for existing tokens) and rotates/revokes the space's bearer webhook token.
  - **Embedded Memory Editor**: Direct access to space memory management.

### 3.2 Workers

Lists `WorkerNode`s serving the caller's spaces (`online` / `busy` / `offline`, `activeSlots / maxSlots`, `hostname`, `tags`, `spaceIds`, last heartbeat age).

### 3.3 Tickets & Manual Review Resolution

- **Filtering & Creation**: Filters tickets across all member spaces or a specific space; provides a creation form (`spaceId`, `title`, `objective`, `contextSummary`, `requiredTags` — omitting `idempotent` so manually created tickets default to conservative trace-verified retry).
- **Ticket Detail & Attempt Replay**: Selecting a ticket fetches `GET /api/tickets/:id/runs`, rendering each attempt's status, worker, token usage, terminal reason, and expandable `EventTrace` (`tool_call`, `tool_result`, `assistant_text`, `system_note`).
- **Lifecycle Controls**:
  - **Cancel ticket** (`POST /api/tickets/:id/cancel`): Shown while `pending`, `claimed`, `running`, or `manual_review`; hidden once terminal.
  - **Manual review actions**: When a ticket parks in `manual_review` after an uncertain lease loss, surfaces **Retry** (`POST /api/tickets/:id/requeue`, enabled when `attempt < 3`) and **Abandon** (`POST /api/tickets/:id/abandon`).

### 3.4 Sessions, Live Transcript Stream, and Mailbox

- **Session list**: Scoped by Space selector; shows window kind/chat, pinned worker, status, and last activity.
- **Resumable Live Transcript**: Opening a session requests a one-time stream grant (`POST /api/sessions/:id/stream-token`) and connects to `/ws/console/:token?afterSeq=<seq>`, appending `CanonicalEvent`s in real time. On disconnect, the viewer tracks its highest received `seq`, acquires a fresh grant, and resumes seamlessly from `afterSeq = seq` without duplicating or missing events.
- **Run Intervention & Close**: Lists the session's `Run`s with a **Stop** button (`POST /api/sessions/:id/runs/:runId/abort`) on non-terminal runs, plus **Close session** (`POST /api/sessions/:id/close`).
- **Mailbox Injection**: Submits `POST /api/sessions/:id/mailbox` (`1–32,000` chars). Delivers with `wait` semantics (never interrupting an active turn), records an attributed `system_note` (`[Console message from <user>]`) in the canonical transcript, and routes any resulting assistant reply to the session's bound IM window.

### 3.5 Schedules

Scoped by Space selector; lists schedules (`action`, `timing`, `status`, `nextFireAt`, `lastFiredAt`), creates `create_ticket` or `resume_session` (`at` / `cron`) schedules, and cancels active schedules (`POST /api/schedules/:id/cancel`).

### 3.6 Space Memory & Conflict Recovery

- Supports prefix filtering, substring/trigram search (`GET /api/memory/search`), full entry inspection, creation (`expected_revision = 0`), updates (`expected_revision = entry.revision`), and deletion.
- **Optimistic conflict UX**: If an agent or another operator updates the same `path` concurrently, saving returns `409 revision_conflict` with `currentRevision`. The editor **retains the user's unsaved draft in place**, displays the conflict banner, and offers an explicit **Reload** action to fetch the latest server revision before re-applying edits — never silently overwriting concurrent writes or discarding local edits.

### 3.7 Global Registries (`Models` & `Channels`)

Accessible to global `admin`s:

- **Models**: Upserts/deletes `ModelRegistry` entries (`id`, `provider`, `model`, `baseUrl`, `apiKey`, `imageInput`, `isDefault`). Existing API keys are never echoed back; leaving `apiKey` blank while editing preserves the stored encrypted key.
- **Channels**: Creates/edits/deletes Feishu bot channels (`name`, `appId`, `appSecret`, `spaceId`, `allowedOpenIds`, `boundChatIds`), preserving stored `appSecret` when left blank on edit.

## 4. Current Implementation Notes

- Console behavioral regressions are currently covered by server HTTP integration suites (`authorization.test.ts`, `v2-acceptance.test.ts`) and browser acceptance runs; there is no dedicated headless component/UI test suite in CI yet.
