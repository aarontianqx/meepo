import { publicChannel } from '../../../domain/channels/channel-service.js';
import type { FastifyInstance } from 'fastify';

import type { Space } from '@meepo/core';

import type { CreateSpaceInput, UpdateSpaceInput } from '../../../domain/spaces/space-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';

interface SpaceParams {
  id: string;
}

export function registerSpaceRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post<{ Params: SpaceParams }>('/api/spaces/:id/webhook-token', async (req) =>
    services.webhookService!.issue(req.params.id)
  );
  app.delete<{ Params: SpaceParams }>('/api/spaces/:id/webhook-token', async (req) => {
    services.webhookService!.revoke(req.params.id);
    return { revoked: true };
  });
  app.get<{ Params: SpaceParams }>(
    '/api/spaces/:id/channels',
    async (req) =>
      services.channelService
        ?.list()
        .filter((c) => c.spaceId === req.params.id)
        .map(publicChannel) ?? []
  );
  app.put<{ Params: { id: string; channelId: string } }>(
    '/api/spaces/:id/channels/:channelId/chats',
    async (req) => {
      await services.channelService?.bindChats(
        req.params.id,
        req.params.channelId,
        (req.body as { chatIds: string[] }).chatIds
      );
      return { saved: true };
    }
  );

  app.delete<{ Params: SpaceParams }>('/api/spaces/:id', async (req) => {
    await services.spaceService.deleteSpace(req.params.id, identityOf(req).userId);
    return { deleted: true };
  });

  app.post('/api/spaces', async (req) => {
    const body = req.body as CreateSpaceInput;
    return services.spaceService.createSpace(body, identityOf(req).userId);
  });

  const view = (space: Space): Space => ({
    ...space,
    boundChatIds: services.channelService
      ? [
          ...new Set(
            services.channelService
              .list()
              .filter((c) => c.spaceId === space.id)
              .flatMap((c) => c.boundChatIds)
          ),
        ]
      : space.boundChatIds,
  });
  app.get('/api/spaces', async (req) =>
    (await services.spaceService.listSpaces(identityOf(req).userId)).map(view)
  );

  app.get<{ Params: SpaceParams }>('/api/spaces/:id', async (req) =>
    view(await services.spaceService.getSpace(req.params.id))
  );

  app.patch<{ Params: SpaceParams }>('/api/spaces/:id', async (req) => {
    const body = req.body as UpdateSpaceInput;
    return services.spaceService.updateSpace(req.params.id, body, identityOf(req).userId);
  });

  app.post<{ Params: SpaceParams }>('/api/spaces/:id/binding', async (req) => {
    const body = req.body as { workerId: string };
    return services.spaceService.switchBinding(
      req.params.id,
      body.workerId,
      identityOf(req).userId
    );
  });

  app.put<{ Params: SpaceParams }>('/api/spaces/:id/model', async (req) => {
    const body = req.body as { model: Space['model'] };
    return services.spaceService.updateModel(req.params.id, body.model, identityOf(req).userId);
  });
}
