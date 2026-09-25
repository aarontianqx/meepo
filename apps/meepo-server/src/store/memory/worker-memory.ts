import type { WorkerNode } from '@meepo/core';

import type { WorkerRepository } from '../../domain/workers/worker-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemoryWorkerRepository extends MemoryTable<WorkerNode> implements WorkerRepository {
  async listServingSpace(spaceId: string): Promise<WorkerNode[]> {
    const all = await this.list();
    return all.filter((row) => row.spaceIds.includes(spaceId));
  }
}
