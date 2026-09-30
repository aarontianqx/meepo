# Feature: Space Memory

Space memory is the agent's shared, curated notebook for a space: team conventions, project background, runbooks, durable facts. It lives server-side (per space, fully isolated) and is accessed through five agent tools and the console.

## 1. Data Model

```typescript
interface MemoryEntry {
  spaceId: string;
  /** Unique per space. POSIX-style, 1–5 segments, each [a-z0-9][a-z0-9-_]{0,63} */
  path: string;
  /** Required, one line, ≤ 200 chars. Appears in directory metadata — include applicability boundaries */
  description: string;
  /** ≤ 10 keywords, each ≤ 32 chars */
  keywords: string[];
  /** Markdown body, ≤ 64 KB */
  content: string;
  /** Per-path monotonic. Survives deletion (tombstone); a recreated path continues the sequence */
  revision: number;
  pinned: boolean;
  updatedAt: number;
  updatedBy:
    | { kind: 'agent'; sessionId: string; authorId?: string } // authorId = open_id of the triggering user, absent for machine turns
    | { kind: 'console'; userId: string };
  /** Reserved for later vector search; unused in v2 */
  embedding?: number[];
}
```

Limits: at most **500 entries per space**; `content` ≤ 64 KB; `description` ≤ 200 chars; `path` 1–5 segments; ≤ 10 keywords.

**Deletion is a tombstone**: the `(path, revision)` row is kept, marked deleted; recreating the path continues its `revision` sequence, so a stale `expected_revision` can never match a recreated entry.

**No version history** (accepted risk): writes are traceable through the session transcript (memory tool calls are events) and `updatedBy`; wrong writes are corrected manually in the console.

## 2. Memory Map (Prompt Injection)

The system prompt carries a **directory-level map** — never entry content — rendered at session creation and appended at the **end** of the system prompt with a staleness disclaimer:

> This map is a snapshot from session start and may be incomplete. Memory tools always return current data — search first; do not answer from this map alone.

Format: one line per top-level directory — `dir/ (count): keyword1, keyword2, …` (up to 5 representative keywords). Budget: ≤ 50 directories and ≤ 1000 chars total; overflow collapses to `… and N more directories`.

Refresh points: new session, cold start (TTL eviction), `/new`. Never refreshed mid-turn. The rendered map is recorded with each `prompt_snapshot` event.

## 3. Retrieval

`MemorySearch` is a **trigram substring match** over `path` / `description` / `keywords` / `content`, ranked, with bounded snippets — explicitly **not** semantic search.

- SQLite: FTS5 with `tokenize='trigram'`; queries shorter than 3 characters fall back to `LIKE '%q%'`.
- Postgres (W9): `pg_trgm` implements the same `MemorySearchPort`; user-visible behavior is unchanged.
- Chinese acceptance case: an entry containing "支付接口重试规则" must be found by the query "重试".

## 4. Agent Tools

Five tools, available in sessions and tickets alike:

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `MemoryList` | `prefix?`, `limit=100` | Directory metadata rows (path, description, keywords, revision, updatedAt) — no content | |
| `MemorySearch` | `query` (1–200 chars), `prefix?`, `limit=20` | Matched entries: metadata + `matched_fields` + ≤ 3 snippets (≤ 200 chars each) | Never returns full content |
| `MemoryRead` | `path`, `offset?`/`limit?` or `tail?` (mutually exclusive, limit ≤ 32 KB) | Full or windowed content + revision | |
| `MemoryWrite` | `path`, `description`, `content`, `keywords?`, `pinned?`, `expected_revision` | Updated entry metadata | Upsert. `expected_revision=0` = create-only. Omit `keywords` to preserve, `[]` to clear |
| `MemoryDelete` | `path`, `expected_revision` | Deletion result | Tombstone |

Error codes: `not_found`, `invalid_path`, `invalid_prefix`, `revision_conflict` (carries the current revision), `content_too_large`, `too_many_entries`.

## 5. Server API

Same semantics over HTTP, used by the console and by the worker's tool proxy:

- `GET /api/memory?spaceId&prefix&limit`
- `GET /api/memory/search?spaceId&q&prefix&limit`
- `GET /api/memory/{path}?spaceId&offset&limit&tail`
- `PUT /api/memory/{path}`
- `DELETE /api/memory/{path}?expected_revision`

Authorization: console access requires space membership; the worker proxy authenticates with the worker token and may only touch spaces the worker serves. Console writes record `updatedBy: { kind: 'console', userId }`.
