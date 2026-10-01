import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../database.js';
import { SqliteMemoryRepository } from '../memory-sqlite.js';
import { MemoryService } from '../../../domain/memory/memory-service.js';

describe('space memory contracts', () => {
  let db: Database;
  let memory: MemoryService;
  const actor = { kind: 'console', userId: 'alice' } as const;
  const value = {
    path: 'payments/retry',
    description: '支付接口重试规则',
    keywords: ['payments'],
    content: '支付接口重试规则：最多三次，避免重复扣款。',
    expected_revision: 0,
  };
  beforeEach(() => {
    db = openDatabase(':memory:');
    memory = new MemoryService(new SqliteMemoryRepository(db));
  });
  afterEach(() => db.close());
  it('finds short Chinese queries and trigrams without cross-space leakage', () => {
    memory.write('a', value, actor);
    expect(memory.search('a', '重试')[0].path).toBe(value.path);
    expect(memory.search('a', '接口重试')[0].path).toBe(value.path);
    expect(memory.search('b', '重试')).toEqual([]);
    expect(memory.list('a')[0]).not.toHaveProperty('content');
    expect(memory.search('a', '重试')[0]).not.toHaveProperty('content');
  });
  it('rejects stale writes and preserves revision monotonicity across delete/recreate', () => {
    expect(memory.write('a', value, actor).revision).toBe(1);
    expect(() => memory.write('a', value, actor)).toThrow('revision changed');
    expect(memory.delete('a', value.path, 1)).toEqual({ revision: 2 });
    expect(memory.write('a', value, actor).revision).toBe(3);
    expect(() => memory.write('a', { ...value, expected_revision: 1 }, actor)).toThrow(
      'revision changed'
    );
    expect(() => memory.delete('a', value.path, 1)).toThrow('revision changed');
  });
  it('validates paths and windows, preserves keywords and keeps UTF-8 whole', () => {
    memory.write('a', value, actor);
    memory.write('a', { ...value, keywords: undefined, expected_revision: 1 }, actor);
    expect(memory.read('a', value.path).keywords).toEqual(['payments']);
    const window = memory.read('a', value.path, { offset: 1, limit: 5 });
    expect(window.content).not.toContain('�');
    expect(() => memory.read('a', value.path, { tail: 2, offset: 0 })).toThrow();
    expect(() => memory.write('a', { ...value, path: '../escape' }, actor)).toThrow();
    expect(() => memory.write('a', { ...value, content: '中'.repeat(22000) }, actor)).toThrow(
      '64 KB'
    );
    expect(memory.map('a')).toContain('payments/ (1): payments');
  });
  it('keeps FTS current on edit and deletion; wildcards remain literal', () => {
    memory.write('a', value, actor);
    memory.write(
      'a',
      { ...value, description: 'other', content: 'replacement', expected_revision: 1 },
      actor
    );
    expect(memory.search('a', '重试')).toEqual([]);
    expect(memory.search('a', 'replacement')).toHaveLength(1);
    expect(memory.search('a', '%')).toEqual([]);
    memory.delete('a', value.path, 2);
    expect(memory.search('a', 'replacement')).toEqual([]);
  });
});
