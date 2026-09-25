import type { FastifyInstance } from 'fastify';

import type { ServiceContainer } from '../../../service-container.js';

interface WorkerParams {
  id: string;
}

interface ListWorkersQuery {
  spaceId?: string;
}

export function registerWorkerRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.get<{ Querystring: ListWorkersQuery }>('/api/workers', async (req) =>
    services.workerService.listWorkers(req.query.spaceId)
  );

  app.get<{ Params: WorkerParams }>('/api/workers/:id', async (req) =>
    services.workerService.getWorker(req.params.id)
  );
}
