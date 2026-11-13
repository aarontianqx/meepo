// Which of the caller's running workers could also serve a given space.

import type { WorkerNode } from '@meepo/core';

import type { EnrollmentRecord } from '../api/types';

export interface ReusableWorker {
  enrollment: EnrollmentRecord;
  worker: WorkerNode;
}

/**
 * Workers behind the caller's live tokens that do not serve `spaceId` yet. A worker is only
 * listed when its token is still valid (an expired or revoked token cannot be extended) and the
 * worker itself is visible to the caller.
 */
export function reusableWorkers(
  enrollments: EnrollmentRecord[],
  workers: WorkerNode[],
  spaceId: string,
  now: number
): ReusableWorker[] {
  const found: ReusableWorker[] = [];
  for (const enrollment of enrollments) {
    if (!enrollment.workerId || enrollment.revokedAt) continue;
    if (enrollment.expiresAt !== undefined && enrollment.expiresAt <= now) continue;
    if (enrollment.spaceIds.includes(spaceId)) continue;
    const worker = workers.find((w) => w.id === enrollment.workerId);
    if (worker) found.push({ enrollment, worker });
  }
  return found.sort(
    (a, b) =>
      Number(b.worker.status !== 'offline') - Number(a.worker.status !== 'offline') ||
      a.worker.hostname.localeCompare(b.worker.hostname)
  );
}
