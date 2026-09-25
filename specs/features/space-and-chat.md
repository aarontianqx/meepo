# Feature: Space and Chat Mapping

## 1. Concept Definition

- **Space**: The sovereign administrative boundary representing a software repository, project, or domain. A Space owns:
  - Repository URL, base branch, and access credentials.
  - Long-term memory store (project conventions, architecture summaries, design constraints).
  - Worker placement policy (required tags, preferred physical machines vs. sandbox).
  - Default timezone for scheduled records (reminders and crons).
  - Linked chat groups.
- **Chat**: An external communication channel (e.g. Feishu group chat `chat_id`).

## 2. Multi-Chat to Space Relationship

A Space supports a **1-to-N** relationship with Feishu Chat groups:

```
[Space: payment-service]
  ├── Git: github.com/org/payment-service
  ├── Memory: "Payment gateway specs & idempotency rules..."
  ├── Bound Chats:
  │     ├── [Dev Chat] payment-engineers (internal discussion, code reviews)
  │     ├── [Support Chat] payment-ops (on-call alerts, merchant inquiries)
  │     └── [PM Chat] payment-roadmap (feature specifications)
```

### Behavioral Rules

1. **Context Sharing**: When `@bot` is invoked in any bound chat, the assistant is primed with the shared Space system prompt and long-term memory.
2. **Channel Awareness**: The assistant knows the source chat metadata (e.g., whether it is answering in the customer support group or dev group), adapting tone and technical depth accordingly.
3. **Cross-Space Isolation**: Context, sessions, and memory never leak across different Spaces.

## 3. Identity, Membership & Worker Placement

- Users authenticate at the edge (SSO); identity is the `userId` from the signed token. MEEPO maintains no account system.
- **Space membership** is the only authorization data MEEPO owns: a `(spaceId, userId) → role` table, unique per user per space. Every authorized member may administer the space (repo config, memory, chat bindings, enrollment tokens, worker binding); exactly one member holds the `owner` role.
- Workers join a Space through enrollment tokens issued by a member — a worker cannot serve a Space without a token covering it.
- Each Space has a worker binding (`boundWorkerId`, configured in the console): it defaults to the first enrolled worker that registers for the space, and determines where the space's main sessions run. Changing the binding is a deliberate user action — main sessions follow the binding, while existing task sessions stay pinned to their original worker.
- A space may have many enrolled workers online. New task sessions dispatch to a randomly chosen eligible worker at creation — a routing-policy hook is reserved for future identity-aware placement (e.g. preferring the triggering user's own machine) — then stay pinned for life.
- Within the enrolled set, the Space's `requiredTags` further filter which workers may pick up its work (e.g. `[macos, private]`).
