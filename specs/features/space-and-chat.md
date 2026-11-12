# Feature: Space and Chat Mapping

> **Scope**: Defines the multi-tenant `Space → Channel → Window` hierarchy, inbound chat-to-space routing rules, authorization roles, worker enrollment and binding semantics, and space configuration defaults.

## 1. Hierarchy: Space, Channel, and Window

Meepo separates **tenant domain boundaries** from **IM bot applications** and **conversation windows**:

```text
[Space: payment-team]  (memory, model ref, prompt preset, boundWorkerId, requiredTags)
  ├── Channel: payment-feishu-bot  (type='feishu', appId, appSecret, allowedOpenIds, boundChatIds)
  │     ├── Window: p2p chat with Alice          ──► Main Session
  │     ├── Window: group chat "payment-devs"    ──► Group Main Session + Thread Sessions
  │     └── Window: group chat "payment-oncall"  ──► Group Main Session + Thread Sessions
  └── Channel: (future Slack / Telegram bot)     ──► Windows sharing the same Space memory & workers
```

- **Space**: A user-defined business or personal boundary (a private assistant, a project team, or a support domain). Context, curated memory, transcripts, tickets, and schedules are strictly isolated per Space and never cross space boundaries. Meepo defines no separate "Assistant Persona" database entity — bot persona and domain conventions live in the Space's description, prompt preset, and curated Memory entries.
- **Channel**: One IM bot application (`{ id, type, name, appId, appSecret, spaceId, allowedOpenIds, boundChatIds }`) registered in the global `ChannelRegistry` and assigned to **exactly one Space**. A Space may own multiple Channels (for example, multiple bots or future IM providers), each maintaining its own independent event connection and deduplication namespace (`channelId`).
- **Window**: A conversation endpoint under a Channel (`windowId = {channelId}:{chatId}:{subId}`) — a private 1:1 chat, a group's main message stream, or a group thread. Every window routed through a Space's channels shares that Space's memory index, model selection, and enrolled worker pool, while receiving source-window metadata (`chatLabel`) so the agent can adapt tone and context appropriately.

_Rationale: Modeling `Channel` between `Space` and `Window` decouples bot credentials from group chats — two bots in the same IM group can belong to different Spaces and be gated independently via `(channelId, chatId)`, while private chats resolve deterministically through their receiving Channel's `spaceId` without requiring per-user pre-binding._

## 2. Window Routing and Trusted Conversation Boundary

1. **Private chats (`p2p`)**: Route automatically to the receiving Channel's `spaceId`. If `channel.allowedOpenIds` is non-empty, only listed user `open_id`s are answered; an empty allowlist (`[]`) admits any user permitted by the IM platform to message the bot.
2. **Group chats (`group`)**: Route to `channel.spaceId` **only** when `chat_id` appears in `channel.boundChatIds` (managed by space members via `PUT /api/spaces/:id/channels/:channelId/chats`). Messages in unbound groups are ignored silently. `ChannelRegistry` is the sole routing authority; `space.boundChatIds` is a read-only display union across the space's channels.
3. **Conversation vs. administration boundary**: Anyone admitted to a bound window may converse with the bot, trigger sessions, and exercise the agent's full tool set (including agent-driven `MemoryWrite`, `CronCreate`, and `TicketCreate`) without holding Console membership. Conversely, configuring a Space, editing Memory directly in the Console, managing bindings/tokens, or cancelling tickets requires explicit Space membership.

## 3. Roles, Worker Enrollment, and Space Binding

### Authorization Roles

Meepo maintains no user account table; authorization maps authenticated `userId`s directly to roles:

- **Space `owner`**: Full control over the space, plus exclusive authority to delete the space, remove members, and transfer ownership.
- **Space `operator`**: Full operational administration of the space (settings, model selection, group chat bindings, memory CRUD, enrollment/webhook token lifecycle, worker rebinding, session/ticket/schedule controls).
- **Global `admin`** (bootstrapped via `MEEPO_ADMIN_USER_IDS`): Manages only the global `Models` and `Channels` registries. Global admin status grants **no** access to private spaces unless the admin is also a member of that space.

### Worker Enrollment and Placement

- **Token-scoped enrollment**: Any space member may issue a `WorkerEnrollmentToken` covering one or more spaces they belong to. A worker can serve only spaces listed on its active, unrevoked, unexpired enrollment token (verified at registration and on every heartbeat).
- **1:1 token-to-worker binding**: An enrollment token binds permanently to the first `workerId` that registers with it. Rotating a compromised token requires issuing a new token and revoking the old one (establishing a new worker identity if re-enrolled).
- **Dedicated vs. shared workers**: The primary deployment pattern is one dedicated worker (or container) per space; enrolling a single worker across multiple spaces is supported when environments are compatible, with the explicit understanding that shared workers share local filesystems, environment credentials, and MCP servers across those spaces.
- **Default binding and explicit rebind**: Each Space holds `boundWorkerId`, automatically initialized when the first enrolled worker registers for an unbound space. Main sessions (`private` and `group-main`) always run on `boundWorkerId`; switching `boundWorkerId` is an explicit member action (`POST /api/spaces/:id/binding`) that migrates main sessions while leaving existing `thread` sessions pinned to their original worker. Within the space's enrolled workers, `space.requiredTags` filters eligible workers for thread placement and ticket dispatch.

## 4. Configuration Reference

| Setting                                    | Default / Scope  | Behavioral Effect                                                                                                       |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Space.timezone`                           | `'UTC'`          | Default IANA timezone for `cron` schedules created in this space.                                                       |
| `Space.promptPreset`                       | `'general'`      | `'coding'` appends isolated `git worktree` rules to new sessions/tickets; frozen once a session's identity is recorded. |
| `Space.model` (`modelId`, `thinkingLevel`) | Server default   | Selects `ModelRegistry` entry and optional `'low' \| 'high' \| 'max'` effort override.                                  |
| `Space.repoUrl` / `defaultBranch`          | `''` / `'main'`  | Optional repository hint included in prompt identity; never triggers automatic cloning.                                 |
| `Space.boundWorkerId`                      | First registered | Hosts all `main` sessions of the space; never changes implicitly when offline.                                          |
| `Space.requiredTags`                       | `[]`             | Tag filter required on workers for thread placement and ticket dispatch (combined with `ticket.requiredTags`).          |
| `Channel.allowedOpenIds`                   | `[]` (open)      | Restricts `p2p` private-chat access to listed `open_id`s when non-empty.                                                |
| `Channel.boundChatIds`                     | `[]` (none)      | Authoritative allowlist of group `chat_id`s routed through this channel.                                                |
