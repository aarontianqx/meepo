import { randomUUID } from 'node:crypto';
import { identityOf } from '../auth.js';
import { validation } from '../../../domain/errors.js';
import type { FastifyInstance } from 'fastify';

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
  delivery?: 'wait';
}

export function registerSessionRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post('/api/sessions', async (req) => {
    const body = req.body as OpenSessionInput;
    if (body.channelId || body.anchorMessageId || body.prewarmMessageId)
      throw validation('IM windows are created by their channel');
    return services.sessionService.getOrCreateByThread({
      spaceId: body.spaceId,
      chatId: `console:${identityOf(req).userId}`,
      threadId: randomUUID(),
      kind: 'main',
    });
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
    if (body.delivery !== undefined && body.delivery !== 'wait')
      throw validation('Session turns only support wait delivery');
    if (typeof body.prompt !== 'string' || !body.prompt.trim())
      throw validation('Prompt is required');
    return services.dispatchService.dispatchSessionTurn({
      sessionId: req.params.id,
      prompt: body.prompt,
      delivery: 'wait',
      authorOpenId: identityOf(req).userId,
      source: { kind: 'user_message', messageId: `http-${randomUUID()}` },
    });
  });
}
