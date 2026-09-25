import { describe, expect, it } from 'vitest';

import { DedupCache } from '../dedup-cache.js';

describe('DedupCache', () => {
  it('reports a key as new the first time and seen afterwards', () => {
    const cache = new DedupCache(30_000, () => 1_000);
    expect(cache.seen('m1')).toBe(false);
    expect(cache.seen('m1')).toBe(true);
    expect(cache.has('m1')).toBe(true);
  });

  it('tracks keys independently', () => {
    const cache = new DedupCache(30_000, () => 1_000);
    cache.add('m1');
    expect(cache.has('m1')).toBe(true);
    expect(cache.has('m2')).toBe(false);
  });

  it('forgets keys once the TTL expires', () => {
    let now = 1_000;
    const cache = new DedupCache(30_000, () => now);
    expect(cache.seen('m1')).toBe(false);

    now += 29_999;
    expect(cache.seen('m1')).toBe(true);

    now += 2;
    expect(cache.has('m1')).toBe(false);
    expect(cache.seen('m1')).toBe(false);
  });

  it('has() does not mark the key', () => {
    const cache = new DedupCache(30_000, () => 1_000);
    expect(cache.has('m1')).toBe(false);
    expect(cache.seen('m1')).toBe(false);
  });
});
