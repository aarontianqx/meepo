import { identityOf } from '../auth.js';
import type { FastifyInstance } from 'fastify';

import type { ServiceContainer } from '../../../service-container.js';

interface WorkerParams {
  id: string;
}

interface ListWorkersQuery {
  spaceId?: string;
}

export function registerWorkerRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.get<{ Querystring: ListWorkersQuery }>('/api/workers', async (req) => {
    const allowed = new Set(
      (await services.membershipService.listMemberships(identityOf(req).userId)).map(
        (m) => m.spaceId
      )
    );
    return (await services.workerService.listWorkers(req.query.spaceId)).filter((x) =>
      x.spaceIds.some((id) => allowed.has(id))
    );
  });

  app.get<{ Params: WorkerParams }>('/api/workers/:id', async (req) =>
    services.workerService.getWorker(req.params.id)
  );
}
