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
  app.post<{ Params: { spaceId: string } }>('/api/webhooks/:spaceId/tickets', async (req) => {
    const body = req.body as {
      title?: string;
      objective: string;
      contextSummary?: string;
      idempotent?: boolean;
    };
    return services.ticketService.createTicket({
      spaceId: req.params.spaceId,
      title: body.title ?? 'Webhook event',
      objective: body.objective,
      contextSummary: body.contextSummary,
      idempotent: body.idempotent,
    });
  });

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
