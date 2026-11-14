import type { FastifyInstance } from 'fastify';

import type {
  ModelInput,
  ModelService,
  ProviderInput,
} from '../../../domain/models/model-service.js';

/** Administers providers and models; the selector list is open to every signed-in user. */
export function registerModelRoutes(app: FastifyInstance, service: ModelService): void {
  app.get('/api/providers', async () => service.listProviders());
  app.put('/api/providers', async (req) => service.putProvider(req.body as ProviderInput));
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    service.deleteProvider(req.params.id);
    return { deleted: true };
  });
  app.get('/api/models', async () => service.listModels());
  app.put('/api/models', async (req) => service.putModel(req.body as ModelInput));
  app.delete<{ Params: { id: string } }>('/api/models/:id', async (req) => {
    await service.deleteModel(req.params.id);
    return { deleted: true };
  });
  app.get('/api/model-options', async () => service.listModels());
}
