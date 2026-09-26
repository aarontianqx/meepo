import type { FastifyInstance } from 'fastify';

import type { ModelEntry, ModelRegistry } from '../../../config.js';

/** Lists globally available models (id + provider) for the console's model selector. */
export function registerModelRoutes(app: FastifyInstance, models: ModelRegistry): void {
  app.get('/api/models', async () =>
    models.entries.map((entry: ModelEntry) => ({
      id: entry.id,
      provider: entry.provider,
      baseUrl: entry.baseUrl,
      model: entry.model,
      isDefault: entry.id === models.defaultModelId,
    }))
  );
}
