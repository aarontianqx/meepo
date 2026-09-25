import type { WorkerNode } from '@meepo/core';

import { notFound } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';
import type { WorkerRepository } from '../workers/worker-repository.js';

export interface DispatchRequest {
  spaceId: string;
  /** Worker already holding the session, for affinity routing */
  preferredWorkerId?: string;
}

/**
 * Capacity-aware worker selection, in priority order:
 * 1. Session affinity (preferred worker, if eligible).
 * 2. Eligibility: online, enrolled for the space, tag-matched, has a free slot.
 * 3. Least-loaded (lowest activeSlots / maxSlots ratio).
 * Returns undefined when every eligible worker is saturated — callers queue.
 */
export class Dispatcher {
  constructor(
    private readonly workers: WorkerRepository,
    private readonly spaces: SpaceRepository
  ) {}

  async selectWorker(request: DispatchRequest): Promise<WorkerNode | undefined> {
    const space = await this.spaces.getById(request.spaceId);
    if (!space) throw notFound(`Space not found: ${request.spaceId}`);

    const eligible = (await this.workers.listServingSpace(space.id)).filter(
      (worker) =>
        worker.status !== 'offline' &&
        worker.activeSlots < worker.maxSlots &&
        space.requiredTags.every((tag) => worker.tags.includes(tag))
    );

    if (request.preferredWorkerId) {
      const preferred = eligible.find((worker) => worker.id === request.preferredWorkerId);
      if (preferred) return preferred;
    }

    return eligible.sort((a, b) => a.activeSlots / a.maxSlots - b.activeSlots / b.maxSlots)[0];
  }
}
