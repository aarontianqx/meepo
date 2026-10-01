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

  app.get<{ Querystring: { spaceId: string } }>('/api/enrollments', async (req) =>
    services.enrollmentService.list(req.query.spaceId, identityOf(req).userId)
  );
  app.post<{ Params: { id: string } }>('/api/enrollments/:id/revoke', async (req) => {
    await services.enrollmentService.revoke(req.params.id, identityOf(req).userId);
    return { revoked: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/spaces/:id/members/:userId',
    async (req) => {
      await services.membershipService.removeMember(
        req.params.id,
        req.params.userId,
        identityOf(req).userId
      );
      return { removed: true };
    }
  );
  app.post<{ Params: { id: string } }>('/api/spaces/:id/owner', async (req) => {
    await services.membershipService.transferOwnership(
      req.params.id,
      (req.body as { userId: string }).userId,
      identityOf(req).userId
    );
    return { transferred: true };
  });

  app.post('/api/enrollments', async (req) => {
    const body = req.body as IssueEnrollmentInput;
    return services.enrollmentService.issueEnrollment(body, identityOf(req).userId);
  });
}
