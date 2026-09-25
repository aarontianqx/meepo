import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingResult<T> {
  data: T | null;
  error: string | null;
  refresh: () => void;
}

/** Polls an async loader immediately and on a fixed interval; `refresh` forces a re-run. */
export function usePolling<T>(loader: () => Promise<T>, intervalMs: number): PollingResult<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const result = await loaderRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'request failed');
        }
      }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  return { data, error, refresh };
}
