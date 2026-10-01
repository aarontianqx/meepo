# MEEPO

**M**ulti-worker **E**xecution **E**ngine for **P**roject-isolated **O**rchestration.

Meepo connects Feishu conversations to distributed agent workers. The server owns spaces, memory, transcripts, tickets and schedules. Workers execute tools in isolated directories; the console manages and observes execution.

## Local setup

Requires Node.js 22+ and pnpm 11+. Moon is included in the workspace dependencies. SQLite is embedded; no database server or container is required.

```bash
pnpm install
pnpm build
pnpm check
```

The apps are `apps/meepo-server`, `apps/meepo-worker` and `apps/meepo-console`. Shared contracts live in `packages/core` and `packages/protocol`; detailed behavior lives in `specs/architecture` and `specs/features`.

### 1. Start the server

```bash
MEEPO_ADMIN_USER_IDS=aaron \
MEEPO_SECRET_KEY=<64-hex-characters> \
MEEPO_MODEL_PROVIDER=openai-completions \
MEEPO_MODEL_BASE_URL=https://your-model-gateway/v1 \
MEEPO_MODEL_API_KEY=<model-key> \
MEEPO_MODEL_ID=<model-name> \
node apps/meepo-server/dist/index.js
```

Generate the encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it in your private environment configuration. Retain the key with SQLite backups; changing it makes stored model/channel secrets unreadable. Production mode requires it. Development without it uses plaintext and logs a warning.

The server listens on port 8780 and serves the built console. `MEEPO_HOST`, `MEEPO_PORT`, `MEEPO_DB_PATH` and `MEEPO_CONSOLE_DIST` override defaults. The default database is `~/.meepo/server/meepo.db`. Use `MEEPO_HOST=127.0.0.1` for a local-only listener.

The current development authenticator reads `x-meepo-user-id` / `x-meepo-user-name`, with `dev-user` as fallback. Set the console's User field to `aaron` in this example. Replace this adapter with verified edge SSO before exposing the service to untrusted users; global admin status grants access to Models/Channels, not membership in other users' spaces.

### 2. Create a space and enroll a worker

In the console, create a space, then issue a token from its detail page. The creator is the owner; other members have the operator role. A token's plaintext is shown once.

```bash
MEEPO_ENROLLMENT_TOKEN=<issued-token> node apps/meepo-worker/dist/index.js
```

The first worker enrolled for a space becomes its default binding. The worker persists its identity under `~/.meepo/worker/worker-id`; keep that file across restarts. A token is bound to one worker identity. Rebinding a space interrupts its active main sessions and moves queued inputs; thread sessions retain their original worker.

### 3. Connect Feishu

As a global admin, create a Channel with the bot's application ID/secret and the target space ID. Add allowed group chat IDs on the space's Channels section or the global channel editor. An empty private-chat allowlist accepts any user who can message the bot.

In the Feishu developer console, enable the bot, publish the required permissions, and use long connection delivery for `im.message.receive_v1` and `card.action.trigger`. The bot needs message receive/read/send/reply, image-resource download and CardKit create/update permissions. Add it to the test group. No public callback endpoint or logged-in Feishu browser is needed.

A new group `@bot` message creates a thread; subsequent messages in an engaged thread do not require mentions. Private chats and group main windows support `/new` (group commands require `@bot`). Use the card Stop button or the console's run Stop action to interrupt execution.

Legacy `MEEPO_FEISHU_APP_ID`, `MEEPO_FEISHU_APP_SECRET`, `MEEPO_DEFAULT_SPACE_ID` are imported once into the channel registry when the named space exists. Subsequent credential edits belong in the registry. `MEEPO_MODELS` can similarly seed a JSON array of `{id,provider,model,baseUrl,apiKey,imageInput?}`; the persisted registry becomes authoritative after first boot.

## Worker configuration

The default file is `~/.meepo/worker.toml`; override with `MEEPO_WORKER_CONFIG`. JSON files are also supported. Protect configuration containing credentials with mode `0600`.

```toml
serverUrl = "ws://127.0.0.1:8780/ws/worker"
enrollmentToken = "<issued-token>"
dataDir = "/home/you/.meepo/worker"
sessionsDir = "/home/you/.meepo/sessions"
ticketsDir = "/home/you/.meepo/tickets"
maxSlots = 2
tags = ["linux", "dev"]
sessionTtlMs = 3600000

[modelDefaults]
thinkingLevel = "high"

[mcp.local]
command = "node"
args = ["/absolute/path/to/mcp-server.mjs"]
timeoutSeconds = 30

[mcp.remote]
url = "https://your-mcp-server/mcp"
timeoutSeconds = 60
# [mcp.remote.headers]
# Authorization = "Bearer <private-token>"
```

Environment overrides: `MEEPO_SERVER_URL`, `MEEPO_ENROLLMENT_TOKEN`, `MEEPO_DATA_DIR`, `MEEPO_WORKER_ID`, `MEEPO_TAGS` (comma separated), `MEEPO_MAX_SLOTS`, `MEEPO_SESSIONS_DIR`, `MEEPO_TICKETS_DIR`, `MEEPO_SESSION_TTL_MS`, `MEEPO_THINKING_LEVEL`. An explicit worker ID must match the persisted identity. Space model thinking settings override worker defaults.

MCP and model defaults reload when the file changes. Failed reloads retain the previous generation. Warm sessions retain their model and tools; new tickets and cold sessions use the new configuration. Connection, identity, tags, paths, TTL and slot count require a worker restart. MCP supports stdio and Streamable HTTP; tools are named `mcp__<server>__<tool>`. Old connections close when their last warm session releases them.

Workers read `~/.agents/AGENTS.md` and skill descriptions under `~/.agents/skills/` at cold start. The general prompt has no compulsory git workflow; select the coding preset on a space to enable worktree guidance. Task directories are `<sessionsDir>/<sessionId>` and `<ticketsDir>/<ticketId>/attempt-N`. Ordinary worker restarts preserve them; closed/rebound sessions release their old local directory. Inactive task directories are reclaimed after seven days.

## Console and APIs

The console provides Spaces, Workers, Tickets, Sessions, Schedules, Memory, Models and Channels. Memory writes use optimistic revisions; on conflict reload the current revision before editing. Session transcripts follow a resumable WebSocket stream, and mailbox messages queue behind current work. Ticket detail shows attempts, tool traces, usage and manual-review actions.

All requests below use the caller's development identity; substitute the real edge authenticator when deployed.

```bash
curl -X POST localhost:8780/api/sessions \
  -H 'content-type: application/json' -H 'x-meepo-user-id: aaron' \
  -d '{"spaceId":"<space-id>"}'

curl -X POST localhost:8780/api/sessions/<session-id>/turns \
  -H 'content-type: application/json' -H 'x-meepo-user-id: aaron' \
  -d '{"prompt":"hello","delivery":"wait"}'

curl -X POST localhost:8780/api/webhooks/<space-id>/tickets \
  -H 'content-type: application/json' -H 'x-meepo-user-id: aaron' \
  -d '{"title":"External event","objective":"Summarize this event","contextSummary":"...","idempotent":true}'
```

Issue or rotate a space webhook token from its detail page (or `POST /api/spaces/:id/webhook-token`). External systems use `Authorization: Bearer <token>` at `POST /api/webhooks/:spaceId/tickets`; tokens are hashed and restricted to that space. `DELETE /api/spaces/:id/webhook-token` revokes access. Space members may also call the route with their authenticated identity. Webhook input creates a ticket; it cannot select another origin session or identity. Pending tickets dispatch automatically. For schedules use `POST /api/schedules` with `{spaceId,timing,action}`: `timing` is `{kind:"at",at:<epoch-ms>}` or `{kind:"cron",expression:"0 3 * * *",timezone:"Asia/Shanghai"}`; `action` is `create_ticket` with an objective or `resume_session` with a session ID and prompt.

## Development and operation

```bash
pnpm --filter meepo-server dev
pnpm --filter meepo-worker dev
pnpm --filter meepo-console dev
pnpm check
pnpm build
```

Build shared packages before starting development processes. The console dev server proxies `/api` and `/ws`. Use a single server instance: SQLite and Feishu connection ownership currently assume one control plane. Back up SQLite using its backup API or stop the server before copying the database and WAL. Migrations run automatically on startup without clearing existing records. Enrollment tokens are hashed; channel/model secrets are encrypted; queued dispatches contain references rather than credentials. Use TLS for worker connections crossing trusted local boundaries.

## License

MIT

Downloaded image originals are cached under `<sessionsDir>/.media` independently of the seven-day task-directory cleanup. Preserve that directory when retaining historical media on a worker.
