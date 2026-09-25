# MEEPO

**M**ulti-worker **E**xecution **E**ngine for **P**roject-isolated **O**rchestration.

MEEPO is a project-isolated agent execution and dispatch framework tailored for team IM integration (such as Feishu/Lark). It decouples the centralized conversational control plane from distributed, heterogeneous execution workers (developer laptops, bare-metal servers, and cloud sandboxes).

## Architecture Highlights

- **Space-Isolated Long-Term Memory**: Multi-chat mapping to unified project boundaries (e.g., dev chat + support chat share a single Space memory).
- **Control/Data Plane Separation**: The central server manages Feishu webhooks, routing, and memory persistence without executing heavy local coding tools.
- **Heterogeneous Workers**: Workers run locally on developer laptops or cloud sandboxes, executing coding tasks via isolated Git worktrees and `@earendil-works/pi-agent-core`.
- **Dual Interaction Modes**:
  - **Interactive Session**: Low-latency, capacity-aware streaming session mapped to Feishu message threads.
  - **Ticket Pipeline**: Asynchronous ticket-driven background runs for PR creation, batch test execution, and Cron automation.

## Workspace Layout

```
meepo/
├── apps/
│   ├── meepo-server/      # Central Control Plane
│   ├── meepo-worker/      # Worker Execution Daemon
│   └── meepo-console/     # Management Dashboard (React + Vite)
├── packages/
│   ├── core/              # Domain Models & Core Interfaces
│   ├── protocol/          # Wire Contracts & Event Envelopes
│   └── sdk/               # Programmatic Client SDK
└── specs/                 # Architectural & Feature Specifications
```

## Quick Start

### Prerequisites

- Node.js >= 22.0.0
- pnpm >= 11.0.0
- [Moon](https://moonrepo.dev/) CLI: `npm install -g @moonrepo/cli`

### Installation

```bash
# Install dependencies across all packages
pnpm install
```

### Development & Checks

```bash
# Run lint, typecheck, and tests across all projects
pnpm check

# Format source code
pnpm format
```

### Running the Stack Locally

```bash
# 1. Start the control plane (HTTP API on :8780, worker channel on /ws/worker)
#    Optional env: MEEPO_DB_PATH (default .meepo/meepo.db),
#    MEEPO_MODEL_PROVIDER/BASE_URL/API_KEY/ID (server-held default model),
#    MEEPO_FEISHU_APP_ID/MEEPO_FEISHU_APP_SECRET (enable the Feishu gateway),
#    MEEPO_DEFAULT_SPACE_ID (space for private chats)
MEEPO_MODEL_PROVIDER=openai-completions \
MEEPO_MODEL_BASE_URL=https://your-llm-gateway/v1 \
MEEPO_MODEL_API_KEY=sk-... \
MEEPO_MODEL_ID=your-model \
pnpm --filter meepo-server dev

# 2. Create a space (dev auth reads the x-meepo-user-id header; the creator becomes owner)
curl -X POST localhost:8780/api/spaces -H 'content-type: application/json' \
  -H 'x-meepo-user-id: aaron' \
  -d '{"name": "demo", "repoUrl": "git@github.com:org/demo.git"}'

# 3. Issue a worker enrollment token for the space
curl -X POST localhost:8780/api/enrollments -H 'content-type: application/json' \
  -H 'x-meepo-user-id: aaron' \
  -d '{"spaceIds": ["<space-id>"]}'

# 4. Start a worker with the issued token (registers + heartbeats;
#    the first enrolled worker to register wins the space's default binding)
#    Optional env: MEEPO_SERVER_URL, MEEPO_WORKER_ID, MEEPO_TAGS, MEEPO_MAX_SLOTS,
#    MEEPO_WORKSPACE_DIR, MEEPO_SESSION_TTL_MS
MEEPO_ENROLLMENT_TOKEN=mep_... pnpm --filter meepo-worker dev

# 5. Start the admin console (Vite dev server proxies /api and /ws to the server)
pnpm --filter meepo-console dev
```

In production, `meepo-server` serves the built console SPA directly (`pnpm --filter meepo-console build`, then `MEEPO_CONSOLE_DIST=apps/meepo-console/dist pnpm --filter meepo-server start`).

### Driving the Pipeline Without IM

```bash
# Create a session and inject a turn (worker must be connected)
curl -X POST localhost:8780/api/sessions -H 'content-type: application/json' \
  -H 'x-meepo-user-id: aaron' \
  -d '{"spaceId": "<space-id>", "chatId": "dev", "threadId": "dev-1", "kind": "main"}'
curl -X POST localhost:8780/api/sessions/<session-id>/turns \
  -H 'content-type: application/json' -d '{"prompt": "hello"}'

# Create and dispatch a ticket
curl -X POST localhost:8780/api/tickets -H 'content-type: application/json' \
  -H 'x-meepo-user-id: aaron' \
  -d '{"spaceId": "<space-id>", "title": "audit", "objective": "..."}'
curl -X POST localhost:8780/api/tickets/<ticket-id>/dispatch

# Schedule a reminder (fires into a new ticket)
curl -X POST localhost:8780/api/reminders -H 'content-type: application/json' \
  -H 'x-meepo-user-id: aaron' \
  -d '{"spaceId": "<space-id>", "objective": "nightly audit", "trigger": {"kind": "cron", "cron": "0 3 * * *"}}'
```

## License

MIT
