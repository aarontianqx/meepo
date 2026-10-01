import { DomainError, validation } from '../errors.js';

export interface MemoryEntry {
  spaceId: string;
  path: string;
  description: string;
  keywords: string[];
  content: string;
  revision: number;
  pinned: boolean;
  updatedAt: number;
  updatedBy:
    { kind: 'console'; userId: string } | { kind: 'agent'; sessionId: string; authorId?: string };
}
export type MemoryMetadata = Omit<MemoryEntry, 'content'>;
export interface MemorySearchHit extends MemoryMetadata {
  matched_fields: string[];
  snippets: string[];
}
export class MemoryError extends DomainError {
  constructor(
    readonly memoryCode: string,
    message: string,
    readonly currentRevision?: number
  ) {
    super(
      memoryCode === 'not_found'
        ? 'not_found'
        : memoryCode === 'revision_conflict'
          ? 'conflict'
          : 'validation',
      message
    );
  }
}
export interface MemoryRepository {
  list(spaceId: string, prefix: string, limit: number): MemoryMetadata[];
  get(spaceId: string, path: string): MemoryEntry | undefined;
  search(spaceId: string, query: string, prefix: string, limit: number): MemorySearchHit[];
  TxWrite(entry: Omit<MemoryEntry, 'revision'>, expectedRevision: number): MemoryMetadata;
  TxDelete(spaceId: string, path: string, expectedRevision: number): { revision: number };
}
export interface MemoryWriteInput {
  path: string;
  description: string;
  content: string;
  keywords?: string[];
  pinned?: boolean;
  expected_revision: number;
}
const segment = '[a-z0-9][a-z0-9_-]{0,63}';
const pathPattern = new RegExp(`^${segment}(?:/${segment}){0,4}$`);
function validatePath(path: string): void {
  if (typeof path !== 'string' || !pathPattern.test(path))
    throw new MemoryError('invalid_path', 'Path must contain 1–5 lowercase POSIX segments');
}
function prefixValue(prefix = ''): string {
  if (prefix && !pathPattern.test(prefix.replace(/\/$/, '')))
    throw new MemoryError('invalid_prefix', 'Invalid memory prefix');
  return prefix;
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw validation(`Limit must be between 1 and ${max}`);
  return value;
}
function expected(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw validation('expected_revision is required and must be a nonnegative integer');
}
export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly now: () => number = Date.now
  ) {}
  list(spaceId: string, prefix?: string, limit?: number): MemoryMetadata[] {
    return this.repo.list(spaceId, prefixValue(prefix), bounded(limit, 100, 500));
  }
  search(spaceId: string, query: string, prefix?: string, limit?: number): MemorySearchHit[] {
    if (typeof query !== 'string' || !query.trim() || query.length > 200)
      throw validation('Query must have 1–200 characters');
    return this.repo.search(spaceId, query.trim(), prefixValue(prefix), bounded(limit, 20, 100));
  }
  read(
    spaceId: string,
    path: string,
    options: { offset?: number; limit?: number; tail?: number } = {}
  ) {
    validatePath(path);
    if (options.tail !== undefined && (options.offset !== undefined || options.limit !== undefined))
      throw validation('tail cannot be combined with offset/limit');
    const entry = this.repo.get(spaceId, path);
    if (!entry) throw new MemoryError('not_found', 'Memory entry not found');
    const limit = bounded(options.tail ?? options.limit, 32768, 32768);
    const bytes = new TextEncoder().encode(entry.content);
    const offset =
      options.tail !== undefined ? Math.max(0, bytes.length - limit) : (options.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw validation('offset must be nonnegative');
    // A UTF-8 window starts/ends on character boundaries, never emits partial code points.
    let start = Math.min(offset, bytes.length),
      end = Math.min(start + limit, bytes.length);
    while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return {
      ...entry,
      content: new TextDecoder().decode(bytes.slice(start, end)),
      offset: start,
      nextOffset: end,
      totalBytes: bytes.length,
    };
  }
  write(spaceId: string, input: MemoryWriteInput, actor: MemoryEntry['updatedBy']): MemoryMetadata {
    validatePath(input.path);
    expected(input.expected_revision);
    if (
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      input.description.length > 200 ||
      /[\r\n]/.test(input.description)
    )
      throw validation('Description must be one line, 1–200 characters');
    if (typeof input.content !== 'string') throw validation('content must be a string');
    if (new TextEncoder().encode(input.content).length > 65536)
      throw new MemoryError('content_too_large', 'Content exceeds 64 KB');
    if (
      input.keywords !== undefined &&
      (!Array.isArray(input.keywords) ||
        input.keywords.length > 10 ||
        input.keywords.some((k) => typeof k !== 'string' || !k.trim() || k.length > 32))
    )
      throw validation('At most 10 keywords of 1–32 characters');
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean')
      throw validation('pinned must be boolean');
    const current = this.repo.get(spaceId, input.path);
    return this.repo.TxWrite(
      {
        spaceId,
        path: input.path,
        description: input.description.trim(),
        content: input.content,
        keywords: input.keywords ?? current?.keywords ?? [],
        pinned: input.pinned ?? current?.pinned ?? false,
        updatedAt: this.now(),
        updatedBy: actor,
      },
      input.expected_revision
    );
  }
  delete(spaceId: string, path: string, revision: number) {
    validatePath(path);
    expected(revision);
    return this.repo.TxDelete(spaceId, path, revision);
  }
  map(spaceId: string): string {
    const dirs = new Map<string, { count: number; keywords: Set<string> }>();
    for (const entry of this.repo.list(spaceId, '', 500)) {
      const dir = entry.path.split('/')[0];
      const item = dirs.get(dir) ?? { count: 0, keywords: new Set<string>() };
      item.count++;
      for (const k of entry.keywords) item.keywords.add(k);
      dirs.set(dir, item);
    }
    const lines: string[] = [];
    let used = 0;
    for (const [dir, item] of dirs) {
      const line = `${dir}/ (${item.count}): ${[...item.keywords].slice(0, 5).join(', ')}`;
      if (lines.length >= 50 || used + line.length > 950) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length < dirs.size) lines.push(`… and ${dirs.size - lines.length} more directories`);
    return lines.join('\n');
  }
}
