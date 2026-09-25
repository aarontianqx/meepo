import type { WorkerNode } from '@meepo/core';
import type {
  WorkerHeartbeatPayload,
  WorkerRegisterPayload,
  WorkerRegisterResult,
} from '@meepo/protocol';

import { notFound } from '../errors.js';
import type { EnrollmentService } from '../enrollments/enrollment-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { WorkerRepository } from './worker-repository.js';

export interface WorkerServiceConfig {
  heartbeatIntervalSeconds: number;
  workerOfflineAfterMs: number;
}

export class WorkerService {
  constructor(
    private readonly workers: WorkerRepository,
    private readonly enrollmentService: EnrollmentService,
    private readonly spaceService: SpaceService,
    private readonly config: WorkerServiceConfig
  ) {}

  /**
   * Registers (or re-registers) a worker. The enrollment token decides which
   * spaces the worker is bound to — workers never self-select spaces. The first
   * enrolled worker to register for a space wins its default binding.
   */
  async register(payload: WorkerRegisterPayload): Promise<WorkerRegisterResult> {
    const enrollment = await this.enrollmentService.resolveEnrollment(payload.enrollmentToken);
    const worker: WorkerNode = {
      id: payload.workerId,
      spaceIds: [...enrollment.spaceIds],
      hostname: payload.hostname,
      tags: payload.tags,
      maxSlots: Math.max(1, payload.capacity.maxSlots),
      activeSlots: 0,
      status: 'online',
      lastHeartbeatAt: Date.now(),
      version: payload.version,
    };
    await this.workers.save(worker);
    for (const spaceId of worker.spaceIds) {
      await this.spaceService.bindWorkerIfUnbound(spaceId, worker.id);
    }
    return {
      workerId: worker.id,
      spaceIds: worker.spaceIds,
      heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
    };
  }

  async heartbeat(workerId: string, payload: WorkerHeartbeatPayload): Promise<void> {
    const worker = await this.workers.getById(workerId);
    if (!worker) throw notFound(`Worker not registered: ${workerId}`);
    worker.maxSlots = Math.max(1, payload.capacity.maxSlots);
    worker.activeSlots = Math.max(0, payload.capacity.activeSlots);
    worker.lastHeartbeatAt = Date.now();
    worker.status = worker.activeSlots >= worker.maxSlots ? 'busy' : 'online';
    await this.workers.save(worker);
  }

  async markOffline(workerId: string): Promise<void> {
    const worker = await this.workers.getById(workerId);
    if (!worker || worker.status === 'offline') return;
    worker.status = 'offline';
    await this.workers.save(worker);
  }

  /** Marks workers whose heartbeat has gone stale as offline; returns their IDs. */
  async sweepStale(now: number = Date.now()): Promise<string[]> {
    const stale = await this.workers.list();
    const swept: string[] = [];
    for (const worker of stale) {
      if (
        worker.status !== 'offline' &&
        now - worker.lastHeartbeatAt > this.config.workerOfflineAfterMs
      ) {
        worker.status = 'offline';
        await this.workers.save(worker);
        swept.push(worker.id);
      }
    }
    return swept;
  }

  async getWorker(id: string): Promise<WorkerNode> {
    const worker = await this.workers.getById(id);
    if (!worker) throw notFound(`Worker not found: ${id}`);
    return worker;
  }

  async listWorkers(spaceId?: string): Promise<WorkerNode[]> {
    return spaceId ? this.workers.listServingSpace(spaceId) : this.workers.list();
  }
}
