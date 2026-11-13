import { useCallback, useState } from 'react';

import { useToast } from './Toast';

interface RunOptions {
  /** Toast shown on success. */
  success?: string;
  /** Identifies which row/button is busy when one component triggers several actions. */
  key?: string;
  /** Surface failures as a toast (default). Disable when the caller renders the error inline. */
  toastError?: boolean;
}

/**
 * Runs a mutation with pending state and toast feedback.
 * Returns the result on success and `undefined` on failure (already reported).
 */
export function useAction(): {
  run: <T>(fn: () => Promise<T>, options?: RunOptions) => Promise<T | undefined>;
  pending: boolean;
  pendingKey: string | undefined;
  error: unknown;
} {
  const toast = useToast();
  const [pendingKey, setPendingKey] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();

  const run = useCallback(
    async <T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T | undefined> => {
      setPending(true);
      setPendingKey(options.key);
      setError(undefined);
      try {
        const result = await fn();
        if (options.success) toast.success(options.success);
        return result;
      } catch (err) {
        setError(err);
        if (options.toastError !== false) toast.error(err);
        return undefined;
      } finally {
        setPending(false);
        setPendingKey(undefined);
      }
    },
    [toast]
  );

  return { run, pending, pendingKey, error };
}
