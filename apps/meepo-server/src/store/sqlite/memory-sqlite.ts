import type { Database } from 'better-sqlite3';
import {
  MemoryError,
  type MemoryEntry,
  type MemoryMetadata,
  type MemoryRepository,
  type MemorySearchHit,
} from '../../domain/memory/memory-service.js';
interface Row {
  space_id: string;
  path: string;
  description: string;
  keywords: string;
  content: string;
  revision: number;
  pinned: number;
  updated_at: number;
  updated_by: string;
  deleted: number;
}
function entry(r: Row): MemoryEntry {
  return {
    spaceId: r.space_id,
    path: r.path,
    description: r.description,
    keywords: JSON.parse(r.keywords) as string[],
    content: r.content,
    revision: r.revision,
    pinned: !!r.pinned,
    updatedAt: r.updated_at,
    updatedBy: JSON.parse(r.updated_by) as MemoryEntry['updatedBy'],
  };
}
function metadata(r: Row): MemoryMetadata {
  const { content: _content, ...meta } = entry(r);
  return meta;
}
function like(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Database) {}
  list(spaceId: string, prefix: string, limit: number): MemoryMetadata[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM memory_entries WHERE space_id = ? AND deleted = 0 AND path LIKE ? ESCAPE '\\' ORDER BY pinned DESC, path LIMIT ?"
        )
        .all(spaceId, like(prefix) + '%', limit) as Row[]
    ).map(metadata);
  }
  get(spaceId: string, path: string): MemoryEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_entries WHERE space_id = ? AND path = ? AND deleted = 0')
      .get(spaceId, path) as Row | undefined;
    return row ? entry(row) : undefined;
  }
  search(spaceId: string, query: string, prefix: string, limit: number): MemorySearchHit[] {
    const long = [...query].length >= 3;
    const selection = long
      ? 'rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)'
      : "(path LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')";
    const term = '%' + like(query) + '%';
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entries WHERE space_id = ? AND deleted = 0 AND path LIKE ? ESCAPE '\\' AND ${selection}`
      )
      .all(
        spaceId,
        like(prefix) + '%',
        ...(long ? ['"' + query.replace(/"/g, '""') + '"'] : [term, term, term, term])
      ) as Row[];
    const q = query.toLowerCase();
    return rows
      .map((r) => {
        const fields = ['path', 'description', 'keywords', 'content'] as const;
        const matched = fields.filter((f) => r[f].toLowerCase().includes(q));
        const snippets: string[] = [];
        let at = 0;
        while (snippets.length < 3) {
          const found = r.content.toLowerCase().indexOf(q, at);
          if (found < 0) break;
          const start = Math.max(0, found - 60);
          snippets.push(r.content.slice(start, start + 200));
          at = Math.max(found + query.length, start + 200);
        }
        return { ...metadata(r), matched_fields: [...matched], snippets };
      })
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          score(b.matched_fields) - score(a.matched_fields) ||
          a.path.localeCompare(b.path)
      )
      .slice(0, limit);
  }
  TxWrite(value: Omit<MemoryEntry, 'revision'>, expected: number): MemoryMetadata {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM memory_entries WHERE space_id = ? AND path = ?')
        .get(value.spaceId, value.path) as Row | undefined;
      // Create-only may recreate a tombstone, but stale positive revisions never do.
      if (expected === 0 ? row && !row.deleted : !row || row.deleted || row.revision !== expected)
        throw new MemoryError('revision_conflict', 'Memory revision changed', row?.revision ?? 0);
      const { count } = this.db
        .prepare('SELECT COUNT(*) AS count FROM memory_entries WHERE space_id = ? AND deleted = 0')
        .get(value.spaceId) as { count: number };
      if ((!row || row.deleted) && count >= 500)
        throw new MemoryError('too_many_entries', 'Space already has 500 memory entries');
      const revision = (row?.revision ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO memory_entries (space_id,path,description,keywords,content,revision,pinned,updated_at,updated_by,deleted) VALUES (?,?,?,?,?,?,?,?,?,0)
        ON CONFLICT(space_id,path) DO UPDATE SET description=excluded.description, keywords=excluded.keywords, content=excluded.content, revision=excluded.revision, pinned=excluded.pinned, updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=0`
        )
        .run(
          value.spaceId,
          value.path,
          value.description,
          JSON.stringify(value.keywords),
          value.content,
          revision,
          +value.pinned,
          value.updatedAt,
          JSON.stringify(value.updatedBy)
        );
      const { content: _content, ...meta } = value;
      return { ...meta, revision };
    })();
  }
  TxDelete(spaceId: string, path: string, expected: number): { revision: number } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM memory_entries WHERE space_id = ? AND path = ?')
        .get(spaceId, path) as Row | undefined;
      if (!row || row.deleted) throw new MemoryError('not_found', 'Memory entry not found');
      if (row.revision !== expected)
        throw new MemoryError('revision_conflict', 'Memory revision changed', row.revision);
      this.db
        .prepare(
          "UPDATE memory_entries SET deleted=1, revision=revision+1, content='' WHERE space_id=? AND path=?"
        )
        .run(spaceId, path);
      return { revision: row.revision + 1 };
    })();
  }
}
function score(fields: string[]): number {
  return fields.reduce(
    (sum, field) => sum + ({ path: 8, description: 4, keywords: 2, content: 1 }[field] ?? 0),
    0
  );
}
