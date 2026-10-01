import type { ModelService } from '../../../domain/models/model-service.js';
import type { FastifyInstance } from 'fastify';

import type { ModelEntry, ModelRegistry } from '../../../config.js';

/** Lists globally available models (id + provider) for the console's model selector. */
export function registerModelRoutes(
  app: FastifyInstance,
  models: ModelRegistry,
  service?: ModelService
): void {
  if (service) {
    app.put('/api/models', async (req) =>
      service.put(req.body as Parameters<ModelService['put']>[0])
    );
    app.delete<{ Params: { id: string } }>('/api/models/:id', async (req) => {
      service.delete(req.params.id);
      return { deleted: true };
    });
  }
  app.get('/api/model-options', async () =>
    models.entries.map((e) => ({
      id: e.id,
      model: e.model,
      provider: e.provider,
      imageInput: e.imageInput,
      isDefault: e.id === models.defaultModelId,
    }))
  );
  app.get(
    '/api/models',
    async () =>
      service?.list() ??
      models.entries.map((entry: ModelEntry) => ({
        id: entry.id,
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        model: entry.model,
        isDefault: entry.id === models.defaultModelId,
      }))
  );
}
