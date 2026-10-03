import { validation } from '../../../domain/errors.js';
import { identityOf } from '../auth.js';
import type { FastifyInstance } from 'fastify';

import type { CreateTicketInput } from '../../../domain/tickets/ticket-service.js';
import type { ServiceContainer } from '../../../service-container.js';

interface TicketParams {
  id: string;
}

interface ListTicketsQuery {
  spaceId?: string;
}

export function registerTicketRoutes(app: FastifyInstance, services: ServiceContainer): void {
  const webhookWindows = new Map<string, { start: number; count: number }>();
  app.post<{ Params: { spaceId: string } }>(
    '/api/webhooks/:spaceId/tickets',
    { bodyLimit: 128 * 1024 },
    async (req, reply) => {
      const now = Date.now();
      for (const [id, window] of webhookWindows)
        if (now - window.start >= 60000) webhookWindows.delete(id);
      const window = webhookWindows.get(req.params.spaceId) ?? { start: now, count: 0 };
      webhookWindows.set(req.params.spaceId, window);
      if (++window.count > 60)
        return reply
          .code(429)
          .header('retry-after', Math.ceil((60000 - now + window.start) / 1000))
          .send({
            error: {
              code: 'rate_limited',
              message: 'Webhook limit: 60 requests per minute per space',
            },
          });
      const key = req.headers['idempotency-key'];
      if (key !== undefined && typeof key !== 'string') throw validation('Invalid Idempotency-Key');
      const body = req.body as {
        title?: string;
        objective: string;
        contextSummary?: string;
        idempotent?: boolean;
      };
      return services.ticketService.createTicket(
        {
          spaceId: req.params.spaceId,
          title: body.title ?? 'Webhook event',
          objective: body.objective,
          contextSummary: body.contextSummary,
          idempotent: body.idempotent,
        },
        key
      );
    }
  );

  app.post('/api/tickets', async (req) => {
    const body = req.body as CreateTicketInput;
    if (body.originSessionId) {
      const session = await services.sessionService.getSession(body.originSessionId);
      if (session.spaceId !== body.spaceId)
        throw validation('Origin session must belong to the ticket space');
    }
    return services.ticketService.createTicket(body);
  });

  app.get<{ Querystring: ListTicketsQuery }>('/api/tickets', async (req) => {
    const allowed = new Set(
      (await services.membershipService.listMemberships(identityOf(req).userId)).map(
        (m) => m.spaceId
      )
    );
    return (await services.ticketService.listTickets(req.query.spaceId)).filter((x) =>
      allowed.has(x.spaceId)
    );
  });

  app.get<{ Params: TicketParams }>('/api/tickets/:id', async (req) =>
    services.ticketService.getTicket(req.params.id)
  );

  app.post<{ Params: TicketParams }>('/api/tickets/:id/requeue', async (req) =>
    services.ticketService.requeueTicket(req.params.id)
  );

  app.post<{ Params: TicketParams }>('/api/tickets/:id/dispatch', async (req) =>
    services.dispatchService.dispatchTicket(req.params.id)
  );
}
