import type { FastifyInstance } from 'fastify';

import type { SettingsService } from '../../../domain/settings/settings-service.js';

/** Global settings; the authorization hook restricts `/api/settings` to global administrators. */
export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService): void {
  app.get('/api/settings/instructions', async () => ({
    instructions: await settings.getGlobalInstructions(),
  }));

  app.put('/api/settings/instructions', async (req) => ({
    instructions: await settings.setGlobalInstructions(
      (req.body as { instructions?: unknown }).instructions
    ),
  }));
}
