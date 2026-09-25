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
  app.post('/api/tickets', async (req) => {
    const body = req.body as CreateTicketInput;
    return services.ticketService.createTicket(body);
  });

  app.get<{ Querystring: ListTicketsQuery }>('/api/tickets', async (req) =>
    services.ticketService.listTickets(req.query.spaceId)
  );

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
