import type { FastifyInstance } from 'fastify';

import type { IssueEnrollmentInput } from '../../../domain/enrollments/enrollment-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';

interface SpaceParams {
  id: string;
}

export function registerMembershipRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.get<{ Params: SpaceParams }>('/api/spaces/:id/members', async (req) =>
    services.membershipService.listMembers(req.params.id, identityOf(req).userId)
  );

  app.post<{ Params: SpaceParams }>('/api/spaces/:id/members', async (req) => {
    const body = req.body as { userId: string };
    return services.membershipService.addMember(req.params.id, body.userId, identityOf(req).userId);
  });

  app.post('/api/enrollments', async (req) => {
    const body = req.body as IssueEnrollmentInput;
    return services.enrollmentService.issueEnrollment(body, identityOf(req).userId);
  });
}
