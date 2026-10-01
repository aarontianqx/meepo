/**
 * Worker-global FIFO semaphore bounding concurrent runs (session turns and
 * tickets) to the worker's maxSlots. Runs that arrive while exhausted wait in
 * arrival order; a released slot is handed directly to the oldest waiter.
 */
export class SlotSemaphore {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; priority: 'session' | 'ticket' }> = [];

  constructor(private readonly maxSlots: number) {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new Error(`maxSlots must be a positive integer, got ${maxSlots}`);
    }
    this.available = maxSlots;
  }

  /** Runs currently holding a slot. */
  get activeCount(): number {
    return this.maxSlots - this.available;
  }

  /** Runs queued for a slot. */
  get waitingCount(): number {
    return this.waiters.length;
  }

  /** Take a slot immediately when free, else wait in FIFO order. */
  acquire(priority: 'session' | 'ticket' = 'session', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Slot wait aborted'));
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Slot wait aborted'));
      };
      const waiter = {
        priority,
        resolve: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** Return a slot, waking the oldest waiter if any. */
  release(): void {
    const index = this.waiters.findIndex((w) => w.priority === 'session');
    const next = this.waiters.splice(index < 0 ? 0 : index, 1)[0];
    if (next) {
      next.resolve();
      return;
    }
    this.available += 1;
  }
}
