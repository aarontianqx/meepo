import type { FastifyInstance } from 'fastify';

import type { Space } from '@meepo/core';

import type { CreateSpaceInput, UpdateSpaceInput } from '../../../domain/spaces/space-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';

interface SpaceParams {
  id: string;
}

interface ChatParams extends SpaceParams {
  chatId: string;
}

export function registerSpaceRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post('/api/spaces', async (req) => {
    const body = req.body as CreateSpaceInput;
    return services.spaceService.createSpace(body, identityOf(req).userId);
  });

  app.get('/api/spaces', async (req) => services.spaceService.listSpaces(identityOf(req).userId));

  app.get<{ Params: SpaceParams }>('/api/spaces/:id', async (req) =>
    services.spaceService.getSpace(req.params.id)
  );

  app.patch<{ Params: SpaceParams }>('/api/spaces/:id', async (req) => {
    const body = req.body as UpdateSpaceInput;
    return services.spaceService.updateSpace(req.params.id, body, identityOf(req).userId);
  });

  app.post<{ Params: SpaceParams }>('/api/spaces/:id/chats', async (req) => {
    const body = req.body as { chatId: string };
    return services.spaceService.bindChat(req.params.id, body.chatId, identityOf(req).userId);
  });

  app.delete<{ Params: ChatParams }>('/api/spaces/:id/chats/:chatId', async (req) =>
    services.spaceService.unbindChat(req.params.id, req.params.chatId, identityOf(req).userId)
  );

  app.put<{ Params: SpaceParams }>('/api/spaces/:id/memory', async (req) => {
    const body = req.body as { longTermMemory: string };
    return services.spaceService.updateMemory(
      req.params.id,
      body.longTermMemory,
      identityOf(req).userId
    );
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
