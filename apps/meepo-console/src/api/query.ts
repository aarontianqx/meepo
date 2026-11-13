/**
 * Tiny shared query cache with polling.
 *
 * Pages and the sidebar frequently need the same data (tickets, sessions, workers). Keying
 * requests lets them share one in-flight fetch and one cached result, so navigating between
 * pages shows data instantly instead of flashing empty states, while polling keeps it live.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { errorMessage } from './client';

interface Entry {
  data: unknown;
  error: string | undefined;
  /** Epoch ms of the last successful fetch; 0 when never fetched. */
  updatedAt: number;
  fetching: boolean;
  fetcher: (() => Promise<unknown>) | undefined;
}

const EMPTY: Entry = {
  data: undefined,
  error: undefined,
  updatedAt: 0,
  fetching: false,
  fetcher: undefined,
};

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
/** One running fetch per key; `token` identifies it so superseded responses can be dropped. */
const inflight = new Map<string, { job: Promise<void>; token: number }>();
let nextToken = 0;
/** Bumped on cache clears so late responses from a previous identity are discarded. */
let epoch = 0;

/** Current cached data for `key`, without subscribing. */
export function peekQuery<T>(key: string): T | undefined {
  return read(key).data as T | undefined;
}

function read(key: string): Entry {
  return entries.get(key) ?? EMPTY;
}

function write(key: string, patch: Partial<Entry>): void {
  entries.set(key, { ...read(key), ...patch });
  for (const listener of listeners.get(key) ?? []) listener();
}

/**
 * Starts a fetch for `key`. A plain call shares a running fetch (polling dedup). A `force` call
 * (after a mutation) always starts a fresh one, because the running request may have been sent
 * before the write and would return stale data; the superseded response is then discarded.
 */
export function fetchQuery(
  key: string,
  fetcher: () => Promise<unknown>,
  force = false
): Promise<void> {
  const running = inflight.get(key);
  if (running && !force) return running.job;
  const startedEpoch = epoch;
  const token = ++nextToken;
  const isCurrent = (): boolean => startedEpoch === epoch && inflight.get(key)?.token === token;
  write(key, { fetching: true, fetcher });
  const job = (async () => {
    try {
      const data = await fetcher();
      if (!isCurrent()) return;
      write(key, { data, error: undefined, updatedAt: Date.now(), fetching: false });
    } catch (error) {
      if (!isCurrent()) return;
      write(key, { error: errorMessage(error), fetching: false });
    } finally {
      if (inflight.get(key)?.token === token) inflight.delete(key);
    }
  })();
  inflight.set(key, { job, token });
  return job;
}

/** Refetches every active key starting with `prefix` (e.g. after a mutation). */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix) && entry.fetcher && (listeners.get(key)?.size ?? 0) > 0)
      void fetchQuery(key, entry.fetcher, true);
    else if (key.startsWith(prefix)) entries.set(key, { ...entry, updatedAt: 0 });
  }
}

/** Drops all cached data; used when the acting identity changes. */
export function clearQueries(): void {
  epoch += 1;
  inflight.clear();
  const active = [...listeners.keys()];
  entries.clear();
  for (const key of active) for (const listener of listeners.get(key) ?? []) listener();
}

/** Seeds or patches cached data directly (optimistic or response-driven updates). */
export function setQueryData<T>(key: string, updater: (current: T | undefined) => T): void {
  // A fetch already in flight predates this write; drop it so it cannot roll the write back.
  inflight.delete(key);
  write(key, {
    data: updater(read(key).data as T | undefined),
    updatedAt: Date.now(),
    fetching: false,
  });
}

export interface QueryResult<T> {
  data: T | undefined;
  error: string | undefined;
  /** True only while there is no data yet. */
  loading: boolean;
  /** True during any in-flight fetch, including background polls. */
  fetching: boolean;
  refresh: () => Promise<void>;
}

export interface QueryOptions {
  /** Poll interval in ms; omit for fetch-once (still refetched after `invalidate`). */
  interval?: number;
  /** Skip fetching entirely (e.g. while a prerequisite id is unknown). */
  enabled?: boolean;
}

/** Subscribes to a keyed query. `key` must uniquely identify what `fetcher` returns. */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: QueryOptions = {}
): QueryResult<T> {
  const { interval, enabled = true } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const active = key !== null && enabled;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === null) return () => undefined;
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key]
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY : read(key)),
    () => EMPTY
  );

  const refresh = useCallback(async () => {
    if (key !== null) await fetchQuery(key, () => fetcherRef.current(), true);
  }, [key]);

  useEffect(() => {
    if (!active || key === null) return undefined;
    const run = (force: boolean): void => {
      const current = read(key);
      const fresh =
        current.updatedAt > 0 && Date.now() - current.updatedAt < (interval ?? 30_000) / 2;
      if (force || !fresh) void fetchQuery(key, () => fetcherRef.current());
    };
    run(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (interval) {
      timer = setInterval(() => {
        if (!document.hidden) run(false);
      }, interval);
    }
    const onVisible = (): void => {
      if (!document.hidden) run(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, key, interval]);

  return {
    data: entry.data as T | undefined,
    error: entry.error,
    loading: active && entry.data === undefined && entry.error === undefined,
    fetching: entry.fetching,
    refresh,
  };
}
