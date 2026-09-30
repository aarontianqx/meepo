# Feature: Space and Chat Mapping

## 1. Concept Definition

- **Space**: A business space — the user-defined boundary for a piece of work or a team (a private assistant, a public group helper, or a whole team's domain). A Space owns:
  - Its **memory** (an entry set with `path`/`description`/`keywords`/`content`/`revision`, indexed in the prompt and read on demand).
  - Its **channels**: one or more bot apps from the ChannelRegistry (channel types beyond Feishu are schema-reserved).
  - Its **worker placement policy** (required tags, preferred machines).
  - Its **model reference** (`modelId` from the model registry + optional thinking level).
  - Its **bound windows**: the chat windows (groups, private chats) across its channels where the bot responds.
- **Channel**: a single bot application (`{ type, appId, appSecret }`) registered in the ChannelRegistry, bound to **exactly one** space. A space may bind multiple channels (e.g. a Feishu bot now, a Telegram bot later). Channel ≠ chat window: one channel (bot) may join many windows.
- **Window**: a chat window under a channel — a private chat, a group, or a thread. Windows on any of the space's channels share the space's context (memory, worker environment).
- **Window routing**: a private chat resolves to the channel's space (a channel binds exactly one space; an optional `allowedOpenIds` whitelist restricts who may talk — empty means anyone). A group chat must be bound as a `{channelId, chatId}` pair; unbound chats stay silent.

## 2. Multi-Chat to Space Relationship

A Space supports a **1-to-N** relationship with chat windows across its bound channels:

```
[Space: payment-team]
  ├── Channel: payment-bot (feishu app)
  ├── Memory: payment gateway specs & idempotency rules (entry set)
  ├── Bound Windows:
  │     ├── [Dev Chat] payment-engineers (internal discussion, code reviews)
  │     ├── [Support Chat] payment-ops (on-call alerts, merchant inquiries)
  │     └── [PM Chat] payment-roadmap (feature specifications)
```

### Behavioral Rules

1. **Context Sharing**: When `@bot` is invoked in any bound chat, the assistant is primed with the shared Space system prompt and memory index.
2. **Channel Awareness**: The assistant knows the source chat metadata (e.g., whether it is answering in the customer support group or dev group), adapting tone and technical depth accordingly.
3. **Cross-Space Isolation**: Context, sessions, and memory never leak across different Spaces.

## 3. Identity, Membership & Worker Placement

- Users authenticate at the edge (SSO); identity is the `userId` from the signed token. MEEPO maintains no account system.
- **Space membership** is the only authorization data MEEPO owns: a `(spaceId, userId) → role` table, unique per user per space. Roles are `owner` and `operator` — both may administer the space. A separate **admin** role exists only for global, non-space configuration and sees no private spaces.
- Workers join a Space through enrollment tokens issued by a member — a worker cannot serve a Space without a token covering it. Tokens carry `{ id, spaceIds[], createdAt, expiresAt? (default none), revokedAt? }`: they may be revoked at any time (rotation = issue new + revoke old), are validated at registration and on every heartbeat (rejection carries a clear reason), and are managed from the console's space page.
- **Worker–Space relationship**: a worker primarily _belongs to_ the space that enrolled it (one worker per space, container-friendly); when environments are compatible, a worker may enroll into multiple spaces.
- Each Space has a worker binding (`boundWorkerId`, configured in the console): it defaults to the first enrolled worker that registers for the space, and determines where the space's main sessions run. Changing the binding is a deliberate user action — main sessions follow the binding, while existing thread sessions stay pinned to their original worker.
- Within the enrolled set, the Space's `requiredTags` further filter which workers may pick up its work (e.g. `[macos, private]`).
- **Trusted conversation boundary**: IM conversation is open to anyone in a bound chat — no console membership required. The bot responds only in chats bound as `{channelId, chatId}` pairs; unbound chats stay silent. Space configuration, tokens, bindings, and direct memory edits require space membership.
