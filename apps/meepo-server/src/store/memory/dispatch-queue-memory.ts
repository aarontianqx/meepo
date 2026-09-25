import type { QueuedDispatch } from '../../domain/dispatch/dispatch-queue-repository.js';
import type { DispatchQueueRepository } from '../../domain/dispatch/dispatch-queue-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryDispatchQueueRepository
  extends MemoryTable<QueuedDispatch>
  implements DispatchQueueRepository
{
  async enqueue(item: QueuedDispatch): Promise<void> {
    await this.save(item);
  }

  async listBySession(sessionId: string): Promise<QueuedDispatch[]> {
    const all = await this.list();
    return all.filter((row) => row.sessionId === sessionId).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    const stale = await this.listBySession(sessionId);
    for (const row of stale) {
      this.rows.delete(row.id);
    }
  }

  async listSessionIds(): Promise<string[]> {
    const all = await this.list();
    return [...new Set(all.map((row) => row.sessionId))];
  }
}
