# Feature: Management Console

> **Scope**: Specifies the information architecture, role-based capabilities, per-section behavior, live transcript observation, emergency mailbox injection, ticket manual-review resolution, and optimistic conflict handling of `meepo-console`. Endpoint wire contracts live in [Control Plane API](../architecture/control-plane-api.md).

## 1. Purpose, Audience, and Explicit Non-Goals

`meepo-console` is a single-page web application (served directly by `meepo-server`) providing **configuration management, execution observability, and operational intervention** for the people who run a Space.

**Audience.** A Space member is a teammate responsible for an agent that mostly works inside an IM group. They do not think in terms of sessions, runs, bindings, or leases; they ask: _Is my agent healthy? What is it doing? What needs my decision? How do I give it work, knowledge, or a new connection?_ The console therefore speaks in product vocabulary — **Conversations** (sessions), **Tickets** (background tasks), **Schedules**, **Memory**, **Workers** (machines), **Settings** — and keeps engine terms (run ids, seq numbers, window ids) out of primary text.

- **Not a Web IM**: Primary human-agent collaboration happens inside IM channels (Feishu). The Console intentionally omits rich multi-turn chat features (threads, image uploads, streaming markdown cards), offering only a bounded **note** (mailbox) input on existing conversations for administrative nudges or recovery.
- **No read-only viewer role**: Conversing with a bot in IM requires zero Console access, so Console visibility is aligned 1:1 with operational responsibility — every Space member (`owner` or `operator`) can inspect and administer that Space, while non-members cannot see the Space at all.

## 2. Role Capability Matrix

| Surface / Action                                                   | Space `operator` | Space `owner` | Global `admin` (non-member) |
| ------------------------------------------------------------------ | :--------------: | :-----------: | :-------------------------: |
| Create a new Space (becomes initial `owner`)                       |        ✓         |       ✓       |              ✓              |
| View/edit Space settings, preset, model (`model-options`), chats   |        ✓         |       ✓       |              —              |
| Rename Space                                                       |        ✓         |       ✓       |              —              |
| Switch Space `boundWorkerId` (triggers `main` rebind)              |        ✓         |       ✓       |              —              |
| Issue/revoke enrollment tokens & rotate/revoke webhook token       |        ✓         |       ✓       |              —              |
| View Space usage totals, Workers, Conversations, Schedules, Memory |        ✓         |       ✓       |              —              |
| Inject a note, stop an active Run, close a Conversation            |        ✓         |       ✓       |              —              |
| Create/cancel Ticket; Retry (`requeue`) or Abandon review          |        ✓         |       ✓       |              —              |
| Add Space members (`operator`)                                     |        ✓         |       ✓       |              —              |
| Remove Space member, transfer ownership, or **Delete Space**       |        —         |       ✓       |              —              |
| Manage global **Models** and **Channels** registries               |        —         |       —       |              ✓              |

Role-dependent controls are **hidden, not disabled with errors**: operators never see owner-only actions, and non-admins see no Platform registry entries (a direct URL shows an "Administrators only" state). The caller's identity and admin flag come from `GET /api/me`.

**Identity.** On start the console always asks the server who the caller is (`GET /api/me`); it sends no identity header of its own unless a development identity was chosen locally, so a server-side default user or an SSO proxy in front of the server works without any console configuration. Only a `401` shows the "choose who you are" form. In development mode (`HeaderAuthenticator`) the user menu exposes a **User** input persisted in `localStorage` (`meepo.userId`) and sent as `x-meepo-user-id`; changing the active user clears the query cache and remounts the view tree so all data refetches under the new principal immediately. The user menu also shows server health (`GET /healthz`, polled every `15s`) and holds the **Theme** preference (`System` / `Light` / `Dark`, persisted locally; `System` follows the OS).

## 3. Information Architecture

The console is **space-centric**: nearly everything a user does happens inside one Space, so the Space is the top-level context and its sections are the primary navigation.

```
Sidebar
├── Space switcher (current space; list of spaces; "New space")
├── Space sections:  Overview · Conversations · Tickets · Schedules · Memory · Workers · Settings
└── Platform:        All spaces · All workers · Models* · Channels*      (* global admins only)
```

- **Routing**: Hash routes keep deep links working behind any reverse-proxy prefix and need no server fallback rules — `#/s/:spaceId/<section>[/<item>][?query]`, `#/spaces`, `#/workers`, `#/models`, `#/channels`. The last visited space is remembered locally and opened on the bare root.
- **Item selection** lives in the URL (`conversations/<sessionId>`, `tickets/<ticketId>`, `memory/<path>`, `settings/<tab>`), so every view is linkable and survives reload.
- **Query hints**: `?new=1` opens the creation dialog of a section (tickets, schedules, spaces); `?filter=<active|review|completed|failed>` preselects a Tickets filter. Overview and the space switcher use these to deep-link into actions.
- **Sidebar signals**: a Tickets badge shows the number of tickets needing review (warning tone) or, when none, in progress; Workers shows a dot when no worker is online.
- **Master-detail**: Conversations, Tickets, and Memory show a list beside a detail pane. Below `900px` the sidebar becomes a drawer and the split views collapse to one pane at a time with a back control.
- **Live data**: Lists poll lightly (5–30 s depending on volatility) through a shared query cache; mutations invalidate affected queries so no manual refresh is ever needed. Destructive actions use an in-app confirm dialog stating the consequence.

## 4. Sections

### 4.1 Spaces

- **All spaces**: Cards for every space the user belongs to (name, description, active/needs-review ticket counts, online workers) plus a creation dialog (`name`, `promptPreset` as _General assistant_ / _Software development_; advanced: `description`, `timezone`, `requiredTags`).
- **Space switcher**: Popover over the same data (with search once the list is long); selecting a space preserves the current section when possible.

### 4.2 Overview

The landing page of a Space answers "is everything fine, and what should I do next?":

- **Get started checklist** (hidden once complete): _Connect a worker_, _Connect a chat_ (a bound group), _Give it a first task_ (any conversation or ticket exists), each linking to the exact place to do it.
- **Needs attention**: Actionable alerts only — tickets awaiting manual review, tickets failed in the last 24 h, all workers offline, tickets waiting over 10 minutes for a worker (likely a tag mismatch). Absent when healthy.
- **At a glance**: Counts of conversations, tickets in progress, workers online (with slot use), and usage totals (`runCount`, input/output tokens; cost shown only when at least one run reported it — unreported cost is never shown as `$0.00`).
- **Recent conversations / tickets** and **upcoming schedules**.
- Primary action: **New ticket**.

### 4.3 Conversations (sessions)

- **List**: Each row is named by its opening message (`title`), with where it lives (`Group · <chat>`, `Private chat · <author>`, `Thread · <chat>`, `Console · <user>`), status, and last activity. Searchable; filtered by _Open_ / _Closed_ and by kind (group, private, thread, console). Sessions have no name of their own; the server derives `title`/`chatLabel`/`author` from the opening user message, using the user's own words (a quoted parent is not part of the title).
- **Live transcript**: Opening a conversation requests a one-time stream grant (`POST /api/sessions/:id/stream-token`) and connects to `/ws/console/:token?afterSeq=<seq>`, appending `CanonicalEvent`s in real time. On disconnect the viewer tracks its highest received `seq`, acquires a fresh grant, and resumes from `afterSeq = seq` without duplicating or missing events. A live indicator shows connected / reconnecting / closed.
- **Rendering**: Events become a readable timeline: user and assistant messages (safe Markdown, no raw HTML; a message that replied to another shows the quoted parent as a "Replying to" block instead of raw markup), attributed console notes, collapsible tool calls paired with their results (name, one-line argument summary, duration, error state), and a collapsed setup row for the base prompt shown once. The view sticks to the bottom while following and shows a **Latest** button otherwise.
- **Intervention**: **Stop** (`POST /api/sessions/:id/runs/:runId/abort`) appears only while the agent is working; **Close** (`POST /api/sessions/:id/close`) after confirmation.
- **Notes (mailbox)**: Submits `POST /api/sessions/:id/mailbox` (`1–32,000` chars). Delivers with `wait` semantics (never interrupting an active turn), records an attributed `system_note` (`[Console message from <user>]`) in the canonical transcript, and routes any resulting assistant reply to the conversation's bound IM window.

### 4.4 Tickets & Manual Review Resolution

- **List**: Filters _All_ / _Active_ / _Review_ / _Done_ / _Failed_ (failed includes cancelled) with counts, plus text search; **New ticket** (`title`, `objective`, optional context, `requiredTags` — omitting `idempotent` so manually created tickets default to conservative trace-verified retry).
- **Detail**: Outcome first (result or failure reason), then facts (status, created, time taken/so far, tags, origin), then **attempts**: `GET /api/tickets/:id/runs` renders each attempt's status, worker, token usage, terminal reason, and expandable event trace (`tool_call`, `tool_result`, `assistant_text`, `system_note`).
- **Lifecycle controls**:
  - **Cancel ticket** (`POST /api/tickets/:id/cancel`): Shown while `pending`, `claimed`, `running`, or `manual_review`; hidden once terminal.
  - **Manual review**: When a ticket parks in `manual_review` after an uncertain lease loss, a prominent panel explains that the interrupted attempt's outcome is unknown and offers **Retry** (`POST /api/tickets/:id/requeue`, enabled when `attempt < 3`) and **Abandon** (`POST /api/tickets/:id/abandon`).

### 4.5 Schedules

Lists **Active** schedules (soonest `nextFireAt` first, with a plain-English timing such as "Weekdays at 09:00 (Asia/Shanghai)") and **Finished** ones (`done`), and cancels active schedules (`POST /api/schedules/:id/cancel`). The creation dialog offers _once at a time_ or _repeating_ (presets for common cron shapes plus a raw 5-field expression, interpreted in the Space timezone) and an action of _create a ticket_ or _send a prompt to a conversation_ (`resume_session`).

### 4.6 Memory & Conflict Recovery

- A folder tree of entries (pinned first) with prefix filtering, substring/trigram search (`GET /api/memory/search`), entry viewing, creation (`expected_revision = 0`), updates (`expected_revision = entry.revision`), and deletion. Path, size, keyword, and entry-count limits are validated client-side with the same rules as the server; the pane shows who last wrote an entry (a console user, or the agent with a link to the originating ticket or conversation).
- **Optimistic conflict UX**: If an agent or another operator updates the same `path` concurrently, saving returns `409 revision_conflict` with `currentRevision`. The editor **retains the user's unsaved draft in place**, displays a conflict banner, and offers explicit choices — **Review latest** (loads the current version for inspection), then **Overwrite with my draft** (saves immediately against the latest revision) or **Use latest** (drops the draft); **Discard changes** is always available — never silently overwriting concurrent writes or discarding local edits. If the note was **deleted** meanwhile (the server reports revision `0`), the banner says so and offers **Save my draft as a new note**. Opening **Edit** alone does not count as an unsaved change; only a real difference from the stored note marks a draft.

### 4.7 Workers

- **Space workers**: Connected workers (hostname or the name of the join token that enrolled it, status, heartbeat age, version, spaces served, tags, slot usage); the **Primary** worker is the one `main` sessions follow, and **Make primary** (`POST /api/spaces/:id/binding`) asks for confirmation noting that active main conversations will be interrupted and migrated while thread conversations stay where they are.
- **Add worker**: When the user already runs workers that do not serve this space yet (live tokens they issued, `GET /api/enrollments` without `spaceId`), the dialog first offers **A worker I already run**: pick one and **Add to this space** (`POST /api/enrollments/:id/spaces`); it serves the space at once, with a note that spaces sharing a worker share its machine. Otherwise, or via **A new machine**, a two-step dialog — name the join token (validity defaults to _Never expires_; optionally cover more spaces) then show the ready-to-run start command with the plaintext token **once** and a one-time warning, polling until the worker connects.
- **Join tokens**: Table with state _Waiting for a worker_ / _In use_ / _Expired_ / _Revoked_, creator, created and last-used times, and **Revoke**. A token binds permanently to the first worker that uses it, and an expired token also blocks reconnect — the dialog states both.
- **All workers** (Platform): Workers across all the user's spaces.

### 4.8 Settings

Section links addressed by `settings/<tab>` (real links, so they can be opened in a new tab):

| Tab         | Content                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **General** | Name, description, timezone, required tags; read-only Space id; owner-only **Delete space** danger zone requiring the space name to be typed.                                                               |
| **Agent**   | Model from credential-free `GET /api/model-options` with `thinkingLevel` (`low` / `high` / `max`); prompt preset _General assistant_ / _Software development_ (existing sessions keep their frozen preset). |
| **Chats**   | Per channel assigned to the Space, the allowed group chat ids (`PUT /api/spaces/:id/channels/:channelId/chats`); an empty list means no group is bound.                                                     |
| **Members** | List and add `operator`s; owners remove members, transfer ownership, with confirmation.                                                                                                                     |
| **Webhook** | Copy-ready `curl` example; generate/rotate/revoke the bearer token (plaintext shown once).                                                                                                                  |

### 4.9 Platform Registries (`Models` & `Channels`, global admins)

- **Models**: Upserts/deletes `ModelRegistry` entries (`id`, `provider`, `model`, `baseUrl`, `apiKey`, `imageInput`, `isDefault`). `provider` is a label (workers speak OpenAI-compatible chat completions). Existing API keys are never echoed back; leaving `apiKey` blank while editing preserves the stored encrypted key. `imageInput` is _Detect_ / _Supported_ / _Not supported_ (mapped to `null` / `true` / `false`). **Make default** and delete (`409` while default).
- **Channels**: Creates/edits/deletes Feishu bot channels (`name`, `appId`, `appSecret`, `spaceId`, `allowedOpenIds`, `boundChatIds`), preserving stored `appSecret` when left blank on edit. An empty `allowedOpenIds` allows everyone.

## 5. Visual and Interaction Principles

- **Quiet by default**: neutral surfaces with a single accent; color is reserved for state (ok / warning / danger). Status is always a label plus a dot, never color alone.
- **Plain language first**: raw ids appear only in secondary, copyable form.
- **Every list has a designed empty, loading (skeleton), and error state**; empty states say what the section is for and offer the next action.
- **Light and dark themes** via design tokens, honoring `prefers-color-scheme` unless overridden.
- **Accessible**: keyboard-operable lists, dialogs with focus trap and `Escape`, labelled icon buttons, visible focus rings, `prefers-reduced-motion` respected.
- **No new runtime dependencies**: React only; icons, Markdown, popovers, toasts, and the query cache are in-repo.

## 6. Current Implementation Notes

- Console logic that is pure (transcript timeline building, cron descriptions, memory tree and path validation) has unit tests colocated with the sources. Server-side console contracts are covered by HTTP integration suites (`authorization.test.ts`, `console-api.test.ts`, `v2-acceptance.test.ts`); there is no component/UI test suite in CI yet.
- Session `title`/`chatLabel`/`author` and schedule `nextFireAt` are computed per list request (one first-event lookup per session); lists are expected to stay small per Space.
