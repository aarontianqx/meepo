import type { FastifyInstance } from 'fastify';

import type { CreateReminderInput } from '../../../domain/schedule/scheduler-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';

interface ReminderParams {
  id: string;
}

interface ListRemindersQuery {
  spaceId?: string;
}

export function registerScheduleRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post('/api/reminders', async (req) => {
    const body = req.body as CreateReminderInput;
    return services.schedulerService.createReminder(body, identityOf(req).userId);
  });

  app.get<{ Querystring: ListRemindersQuery }>('/api/reminders', async (req) => {
    if (!req.query.spaceId) return [];
    return services.schedulerService.listRemindersBySpace(req.query.spaceId);
  });

  app.post<{ Params: ReminderParams }>('/api/reminders/:id/cancel', async (req) =>
    services.schedulerService.cancelReminder(req.params.id)
  );
}
