# MEEPO

**M**ulti-worker **E**xecution **E**ngine for **P**roject-isolated **O**rchestration.

Meepo connects instant-messaging conversations (currently Feishu) and external triggers to distributed, self-hosted agent workers. The control-plane server owns spaces, curated memory, session transcripts, tickets, and schedules; workers execute agents and tools inside isolated per-task directories; the web console manages configuration and observes live execution.

For full architecture and behavioral specifications, start at [`specs/README.md`](specs/README.md).

## Local setup

Requires Node.js 22+ and pnpm 11+. Moon is included in the workspace devDependencies, and SQLite is embedded (no external database server or container is required).

```bash
pnpm install
pnpm build
pnpm check
```

The monorepo contains three applications (`apps/meepo-server`, `apps/meepo-worker`, `apps/meepo-console`) and shared contract packages (`packages/core`, `packages/protocol`, plus reserved `packages/sdk`).

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

Generate the master encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store `MEEPO_SECRET_KEY` securely alongside SQLite backups — rotating or losing it renders encrypted model and channel credentials unreadable. Production mode (`NODE_ENV=production`) requires `MEEPO_SECRET_KEY`; development mode falls back to plaintext storage with a startup warning.

The server listens on `127.0.0.1:8780` by default, stores state at `~/.meepo/server/meepo.db`, and serves the built console SPA when present. Override defaults with `MEEPO_HOST`, `MEEPO_PORT`, `MEEPO_DB_PATH`, `MEEPO_CONSOLE_DIST`, `MEEPO_HEARTBEAT_INTERVAL_SECONDS` (default `15`), and `MEEPO_WORKER_OFFLINE_AFTER_MS` (default `45000`). Set `MEEPO_HOST` explicitly only behind a trusted network or authenticated reverse proxy.

For local development, the header authenticator reads `x-meepo-user-id` and `x-meepo-user-name` (defaulting to `dev-user`). In the console top bar, set **User** to `aaron` to match `MEEPO_ADMIN_USER_IDS`. Production mode refuses startup with header authentication unless `MEEPO_ALLOW_INSECURE_HEADER_AUTH=1` explicitly opts in for an isolated environment; replace this adapter with verified edge SSO before exposing the server to untrusted networks. Global admin status grants access to the **Models** and **Channels** registries only — never to private spaces.

### 2. Create a space and enroll a worker

Open `http://127.0.0.1:8780`, create a space (the creator becomes its `owner`), and issue an enrollment token from the space detail page. Token plaintext is displayed once.

```bash
MEEPO_ENROLLMENT_TOKEN=<issued-token> node apps/meepo-worker/dist/index.js
```

The first enrolled worker to register for an unbound space becomes its default `boundWorkerId`. Each worker generates and persists its stable identity at `~/.meepo/worker/worker-id`; preserve that file across restarts because an enrollment token binds permanently to the first `workerId` that uses it. Explicitly rebinding a space interrupts active main sessions and migrates their queued turns to the new worker, while existing thread sessions remain pinned to their original worker.

### 3. Connect Feishu

As a global admin, register a Feishu channel in **Channels** with its `appId`, `appSecret`, and target `spaceId`. Bind allowed group `chat_id`s from the space detail page or channel editor. An empty private-chat `allowedOpenIds` list admits any user able to message the bot.

In the Feishu Developer Console:

1. Enable the Bot capability.
2. Grant message receive/read/send/reply, image resource download, and CardKit create/update permissions, then publish a version.
3. Configure event delivery via **Long Connection** (WebSocket) for `im.message.receive_v1` and card action callback `card.action.trigger`. No public webhook URL is needed for Feishu events.

In a bound group, mentioning `@bot` in the main stream opens a dedicated thread session; subsequent replies inside an engaged thread require no mention, while replying to a main-stream message with `@bot` continues the group's main session. `/new` resets a private-chat or group-main session (group `/new` requires `@bot`). Use the streaming card's **停止** button or the console's **Stop** action to interrupt an active run.

Seed environment variables (`MEEPO_FEISHU_APP_ID`, `MEEPO_FEISHU_APP_SECRET`, `MEEPO_DEFAULT_SPACE_ID` for a legacy channel; `MEEPO_MODELS` JSON array and `MEEPO_DEFAULT_MODEL_ID` for models) are imported once when empty; thereafter the database registries are authoritative.

## Worker configuration

Workers read `~/.meepo/worker.toml` by default (override with `MEEPO_WORKER_CONFIG`; `.json` is also supported). Protect files containing MCP credentials with mode `0600`.

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

Environment overrides take precedence: `MEEPO_SERVER_URL`, `MEEPO_ENROLLMENT_TOKEN`, `MEEPO_DATA_DIR`, `MEEPO_WORKER_ID` (must match persisted `worker-id` if already initialized), `MEEPO_TAGS` (comma-separated), `MEEPO_MAX_SLOTS` (`1–128`), `MEEPO_SESSIONS_DIR`, `MEEPO_TICKETS_DIR`, `MEEPO_SESSION_TTL_MS`, and `MEEPO_THINKING_LEVEL` (`low` | `high` | `max`).

- **Hot reload**: Editing `mcp` or `modelDefaults` reloads atomically for subsequent tickets and cold-started sessions; failed reloads retain the previous generation. Warm sessions keep their existing model and MCP tool leases until evicted or closed. Connection, identity, paths, tags, TTL, and slot capacity require a worker restart.
- **Local environment & retention**: Cold starts read `~/.agents/AGENTS.md` and skill frontmatter from `~/.agents/skills/*/SKILL.md`. Task directories live at `<sessionsDir>/<sessionId>` and `<ticketsDir>/<ticketId>/attempt-N`; inactive directories older than 7 days are reclaimed automatically, while downloaded image originals in `<sessionsDir>/.media` are retained independently across session cleanup. Oversized tool outputs are saved locally under `<taskDir>/.tool-output/` (`0600`) with a bounded preview sent to the model and server journal.

## Console and HTTP APIs

The console provides **Spaces**, **Workers**, **Tickets**, **Sessions**, **Schedules**, **Memory**, **Models**, and **Channels**. Examples below use the development header authenticator:

```bash
# Open a console/API main session
curl -X POST http://127.0.0.1:8780/api/sessions \
  -H 'content-type: application/json' -H 'x-meepo-user-id: aaron' \
  -d '{"spaceId":"<space-id>"}'

# Enqueue a session turn
curl -X POST http://127.0.0.1:8780/api/sessions/<session-id>/turns \
  -H 'content-type: application/json' -H 'x-meepo-user-id: aaron' \
  -d '{"prompt":"Summarize open work","delivery":"wait"}'

# Trigger an asynchronous ticket via space webhook
curl -X POST http://127.0.0.1:8780/api/webhooks/<space-id>/tickets \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <space-webhook-token>' \
  -H 'idempotency-key: deploy-2026-11-12-01' \
  -d '{"title":"Post-deploy check","objective":"Verify health metrics","idempotent":true}'
```

Webhook tokens are issued, rotated, or revoked per space (`POST` / `DELETE /api/spaces/:id/webhook-token`). Optional `Idempotency-Key` headers (`1–128` printable non-space ASCII characters) deduplicate identical payloads for 30 days and return `409` if reused with a different payload; webhook traffic is capped at `128 KiB` and `60` requests/minute/space. See [`specs/architecture/control-plane-api.md`](specs/architecture/control-plane-api.md) for the complete API contract.

## Development and operations

```bash
pnpm --filter meepo-server dev
pnpm --filter meepo-worker dev
pnpm --filter meepo-console dev
pnpm check
pnpm build
```

- **Single control-plane instance**: Embedded SQLite and per-channel Feishu WebSocket connections assume a single `meepo-server` process. Back up SQLite via the SQLite backup API or after stopping the server (copying WAL files safely).
- **Upgrades**: SQLite schema migrations apply automatically on startup without wiping data; always back up the database before upgrading. Server and worker lockstep on wire protocol version **3** — rebuild and upgrade both together, as mismatched workers are rejected at registration.
- **Security boundaries**: Channel secrets and tenant tokens never leave `meepo-server` (Feishu images are proxied via authorized `media.read` RPCs). Model API keys are encrypted at rest on the server and injected over the worker WebSocket per dispatch — use `wss://` (TLS) whenever workers connect across network boundaries, and enroll only workers whose host operators are trusted with the space's model credentials.

## License

MIT
