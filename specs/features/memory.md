# Feature: Space Memory

> **Scope**: Specifies Meepo's curated, space-scoped long-term knowledge store — entry constraints, tombstone-backed optimistic concurrency, deterministic Memory Map prompt injection, trigram substring retrieval, agent tool contracts, and HTTP/RPC parity.

## 1. Purpose and Entry Model

Space Memory is a shared, curated notebook scoped to a single `Space` — storing durable team conventions, architecture notes, runbooks, and environment facts across sessions and tickets. Rather than stuffing full memory documents into every prompt or running opaque background auto-summarizers, Meepo exposes explicit CRUD/search tools to both the agent and Console members, injecting only a compact directory index (`Memory Map`) at cold start.

Each `MemoryEntry` is uniquely identified by `(spaceId, path)`:

- **`path`**: `1–5` slash-separated lowercase POSIX segments, each matching `[a-z0-9][a-z0-9_-]{0,63}` (e.g., `payments/retry-policy`).
- **`description`**: Single line (`1–200` chars, no CR/LF) summarizing scope and applicability boundaries.
- **`keywords`**: `0–10` non-empty strings (`1–32` chars each) surfaced in the directory map and weighted in search.
- **`content`**: UTF-8 Markdown body (`≤ 64 KiB` / `65,536` bytes).
- **`revision`**: Strictly monotonic positive integer per `(spaceId, path)`.
- **`pinned`**: `boolean` prioritizing the entry in directory map ordering and search ranking.
- **`updatedAt`** & **`updatedBy`**: `{ kind: 'console', userId }` for Console edits, or `{ kind: 'agent', sessionId, authorId? }` for tool writes (`sessionId` carries `ticket:<ticketId>` on ticket runs; `authorId` is derived server-side from `Run.initiatorIds[0]` and omitted on machine turns — never trusted from tool parameters).

Space capacity is capped at **500 active (non-deleted) entries** (`too_many_entries` on overflow).

### Tombstone Deletion and Monotonic Revisions

Deleting an entry marks its storage row `deleted = true` while **retaining `(spaceId, path, revision)` as a tombstone**:

- Creating a brand-new path requires `expected_revision = 0`, producing `revision = 1`.
- Updating or deleting an existing entry requires `expected_revision === current.revision`, incrementing `revision` by `1`.
- Recreating a previously deleted path requires `expected_revision = 0` and resumes at **`tombstone.revision + 1`** (never resetting to `1`).

_Rationale: Preserving monotonic revisions across delete-and-recreate prevents a delayed write holding an old pre-deletion `expected_revision` (e.g., `revision = 2`) from silently clobbering a newly recreated entry at the same path._

**No multi-version history**: Only the latest body is stored in `MemoryEntry`. Auditability comes from `updatedBy` metadata and session/ticket canonical event logs (which record every `MemoryWrite` / `MemoryDelete` tool call).

## 2. Deterministic Memory Map (Prompt Suffix)

At cold start (`prompt.prepare`), the server builds a compact directory summary appended to the **end** of the system prompt — never injecting entry bodies:

1. Read up to `500` active entries ordered deterministically by `pinned DESC, path ASC`.
2. Group entries by their first path segment (`dir = path.split('/')[0]`) in first-encounter order, counting entries per `dir` and collecting unique `keywords` in first-encounter order.
3. Format one line per directory: `<dir>/ (<count>): <kw1>, <kw2>, ...` (up to `5` keywords).
4. Stop adding lines once reaching **50 directories** or **`950` characters** of directory lines (keeping the block within ~`1,000` chars), appending `… and <N> more directories` when truncated (or `(empty)` when the space has zero entries).
5. Prepend the staleness disclaimer instructing the agent to search/read via tools rather than answering from the snapshot alone.

_Rationale: Appending a deterministic, directory-only map at the tail of the prompt gives the agent immediate awareness of what topics exist in the space while keeping warm-turn prompt prefixes stable and preventing answers based on stale inline text._

## 3. Retrieval Contract (`MemorySearch`)

`MemorySearch` performs **literal/trigram substring matching** (explicitly _not_ vector/semantic similarity) across `path`, `description`, `keywords`, and `content` for non-deleted entries in `spaceId` (optionally filtered by `prefix`):

- **CJK and short-query support**: Substring matching works uniformly across English identifiers and Chinese phrases without word-segmentation gaps — queries of `≥ 3` characters use trigram full-text indexing (SQLite FTS5 `tokenize='trigram'`, mappable to `pg_trgm` on PostgreSQL), while `1–2` character queries (such as `"重试"`) fall back to exact substring `LIKE` matching so two-character Chinese terms are reliably found.
- **Deterministic ranking**: Results sort by:
  1. `pinned DESC`
  2. Weighted field match score (`path = 8`, `description = 4`, `keywords = 2`, `content = 1`) `DESC`
  3. `path ASC`
- **Bounded output**: Returns up to `limit` hits (default `20`, max `100`), each containing entry metadata (no full `content`), `matched_fields[]`, and at most `3` contextual snippets (`≤ 200` chars each).

## 4. Agent Tools and HTTP API Parity

All five tools are available identically in interactive sessions and tickets, backed by the same `MemoryService` domain rules as the Console HTTP endpoints:

| Agent Tool     | HTTP Equivalent                                       | Parameters & Limits                                                                                                               | Output                                                                                     |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MemoryList`   | `GET /api/memory?spaceId&prefix&limit`                | `prefix?`, `limit?` (default `100`, max `500`)                                                                                    | `MemoryMetadata[]` (`content` omitted), ordered `pinned DESC, path ASC`.                   |
| `MemorySearch` | `GET /api/memory/search?spaceId&q&prefix&limit`       | `query`/`q` (`1–200` chars), `prefix?`, `limit?` (default `20`, max `100`)                                                        | `MemorySearchHit[]` (`MemoryMetadata` + `matched_fields[]` + `snippets[]`).                |
| `MemoryRead`   | `GET /api/memory/<path>?spaceId&offset&limit&tail`    | `path`, mutually exclusive UTF-8 byte `offset?`+`limit?` or `tail?` (window capped at `32 KiB` / `32,768` bytes)                  | Entry with UTF-8 codepoint-aligned `content` slice + `{ offset, nextOffset, totalBytes }`. |
| `MemoryWrite`  | `PUT /api/memory/<path>?spaceId`                      | `path`, `description`, `content` (`≤ 64 KiB`), `keywords?` (omit preserves existing; `[]` clears), `pinned?`, `expected_revision` | Updated `MemoryMetadata` with incremented `revision`.                                      |
| `MemoryDelete` | `DELETE /api/memory/<path>?spaceId&expected_revision` | `path`, `expected_revision`                                                                                                       | `{ deleted: true, revision }` (tombstoned).                                                |

The HTTP and RPC interfaces answer a read of a missing path with the domain error `not_found`. The agent's `MemoryRead` tool turns that one case into an ordinary result, `{ found: false, message }`, because "nothing stored yet" is a normal answer for an agent probing memory and a thrown tool error makes models retry or apologize; every other error still fails the tool call, and `not_found` on write or delete stays an error.

`MemoryRead` slices strictly on valid UTF-8 character boundaries (advancing `start` past continuation bytes and trimming incomplete trailing sequences before `end`), guaranteeing multi-byte characters are never corrupted across paged reads.

Domain error codes: `not_found` (`404`), `revision_conflict` (`409`, returning `currentRevision` so callers can reload and reconcile), `invalid_path` (`400`), `invalid_prefix` (`400`), `content_too_large` (`400`), and `too_many_entries` (`400`).
