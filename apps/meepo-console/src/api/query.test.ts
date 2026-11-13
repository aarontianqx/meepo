import { beforeEach, describe, expect, it, vi } from 'vitest';

// api/client reads localStorage when imported; node has none.
vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});

import { clearQueries, fetchQuery, peekQuery, setQueryData } from './query';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('query cache', () => {
  beforeEach(() => clearQueries());

  it('shares one running fetch between plain callers', async () => {
    const first = deferred<string>();
    const fetcher = vi.fn(() => first.promise);
    const a = fetchQuery('k', fetcher);
    const b = fetchQuery('k', fetcher);
    first.resolve('v');
    await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peekQuery('k')).toBe('v');
  });

  it('a forced fetch is not swallowed by a running one and wins over its stale response', async () => {
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const poll = fetchQuery('k', () => stale.promise);
    const afterWrite = fetchQuery('k', () => fresh.promise, true);

    fresh.resolve('after write');
    await afterWrite;
    stale.resolve('before write');
    await poll;

    expect(peekQuery('k')).toBe('after write');
  });

  it('keeps optimistic data when a fetch that started earlier returns', async () => {
    const pending = deferred<string[]>();
    const poll = fetchQuery('list', () => pending.promise);
    setQueryData<string[]>('list', () => ['optimistic']);
    pending.resolve(['stale']);
    await poll;
    expect(peekQuery('list')).toEqual(['optimistic']);
  });

  it('drops responses that arrive after the cache was cleared for another identity', async () => {
    const pending = deferred<string>();
    const poll = fetchQuery('k', () => pending.promise);
    clearQueries();
    pending.resolve('previous user');
    await poll;
    expect(peekQuery('k')).toBeUndefined();
  });
});
