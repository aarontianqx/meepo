import type { FastifyInstance } from 'fastify';

import type { CreateScheduleInput } from '../../../domain/schedule/scheduler-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';

interface ScheduleParams {
  id: string;
}

interface ListSchedulesQuery {
  spaceId?: string;
}

export function registerScheduleRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.post('/api/schedules', async (req) => {
    const body = req.body as CreateScheduleInput;
    return services.schedulerService.createSchedule(body, identityOf(req).userId);
  });

  app.get<{ Querystring: ListSchedulesQuery }>('/api/schedules', async (req) =>
    services.schedulerService.listSchedules(req.query.spaceId)
  );

  app.post<{ Params: ScheduleParams }>('/api/schedules/:id/cancel', async (req) =>
    services.schedulerService.cancelSchedule(req.params.id)
  );
}
