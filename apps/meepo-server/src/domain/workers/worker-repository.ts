import type { WorkerNode } from '@meepo/core';

export interface WorkerRepository {
  save(worker: WorkerNode): Promise<void>;
  getById(id: string): Promise<WorkerNode | undefined>;
  list(): Promise<WorkerNode[]>;
  listServingSpace(spaceId: string): Promise<WorkerNode[]>;
}
