import type { FastifyInstance } from 'fastify';

import type { DeliveryMode, DispatchSource } from '@meepo/protocol';

import type { OpenSessionInput } from '../../../domain/sessions/session-service.js';
import type { ServiceContainer } from '../../../service-container.js';

interface SessionParams {
  id: string;
}

interface ListSessionsQuery {
  spaceId?: string;
}

interface PostTurnBody {
  prompt: string;
  delivery?: DeliveryMode;
  source?: DispatchSource;
}

export function registerSessionRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post('/api/sessions', async (req) => {
    const body = req.body as OpenSessionInput;
    return services.sessionService.getOrCreateByThread(body);
  });

  app.get<{ Querystring: ListSessionsQuery }>('/api/sessions', async (req) => {
    if (!req.query.spaceId) return [];
    return services.sessionService.listBySpace(req.query.spaceId);
  });

  app.get<{ Params: SessionParams }>('/api/sessions/:id', async (req) =>
    services.sessionService.getSession(req.params.id)
  );

  app.get<{ Params: SessionParams }>('/api/sessions/:id/snapshot', async (req) =>
    services.transcriptService.getSnapshot(req.params.id)
  );

  /** Injects a user turn into a session (drives the dispatch pipeline without IM). */
  app.post<{ Params: SessionParams }>('/api/sessions/:id/turns', async (req) => {
    const body = req.body as PostTurnBody;
    return services.dispatchService.dispatchSessionTurn({
      sessionId: req.params.id,
      prompt: body.prompt,
      delivery: body.delivery ?? 'wait',
      source: body.source ?? { kind: 'user_message', messageId: `http-${Date.now()}` },
    });
  });
}
