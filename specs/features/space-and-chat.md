# Feature: Space and Chat Mapping

## 1. Concept Definition

- **Space**: The sovereign administrative boundary representing a software repository, project, or domain. A Space owns:
  - Repository URL, base branch, and access credentials.
  - Long-term memory store (project conventions, architecture summaries, design constraints).
  - Worker placement policy (required tags, preferred physical machines vs. sandbox).
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
