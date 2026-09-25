export type Clock = () => number;

/**
 * TTL dedup cache for inbound message ids. Feishu re-pushes events that are
 * not acked within 3 seconds, so the gateway drops repeats by message_id.
 */
export class DedupCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = Date.now
  ) {}

  /** Pure membership check; expired entries count as absent. */
  has(key: string): boolean {
    const now = this.clock();
    this.prune(now);
    return this.entries.has(key);
  }

  add(key: string): void {
    const now = this.clock();
    this.prune(now);
    this.entries.set(key, now + this.ttlMs);
  }

  /** Check-and-mark: returns true when the key was already present. */
  seen(key: string): boolean {
    if (this.has(key)) return true;
    this.add(key);
    return false;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}
