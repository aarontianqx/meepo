/**
 * Worker-global FIFO semaphore bounding concurrent runs (session turns and
 * tickets) to the worker's maxSlots. Runs that arrive while exhausted wait in
 * arrival order; a released slot is handed directly to the oldest waiter.
 */
export class SlotSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

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
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Return a slot, waking the oldest waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}
