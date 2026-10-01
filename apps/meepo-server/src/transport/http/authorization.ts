import type { FastifyInstance } from 'fastify';
import type { ServiceContainer } from '../../service-container.js';
import { identityOf } from './auth.js';
import { unauthorized, validation } from '../../domain/errors.js';

/** Resolve resource ownership from stored entities, never a client-supplied owner. */
export function registerAuthorization(
  app: FastifyInstance,
  services: ServiceContainer,
  admins: string[]
): void {
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    if (path.startsWith('/api/webhooks/') && req.headers.authorization) {
      const spaceId = (req.params as { spaceId: string }).spaceId;
      if (!services.webhookService) throw unauthorized('Webhook authentication unavailable');
      const token = req.headers.authorization.match(/^Bearer (.+)$/)?.[1];
      if (!token) throw unauthorized('Bearer webhook token required');
      services.webhookService.requireToken(spaceId, token);
      return;
    }
    const userId = identityOf(req).userId;
    if (path.startsWith('/api/channels') || path.startsWith('/api/models')) {
      if (!admins.includes(userId)) throw unauthorized('Global administrator required');
      return;
    }
    const params = req.params as { id?: string; spaceId?: string };
    const query = req.query as { spaceId?: string };
    const body = req.body as { spaceId?: string } | undefined;
    let spaceId = params.spaceId ?? query.spaceId ?? body?.spaceId;
    if (path.startsWith('/api/spaces/') && params.id) spaceId = params.id;
    if (path.startsWith('/api/sessions/') && params.id)
      spaceId = (await services.sessionService.getSession(params.id)).spaceId;
    if (path.startsWith('/api/tickets/') && params.id)
      spaceId = (await services.ticketService.getTicket(params.id)).spaceId;
    if (path.startsWith('/api/schedules/') && params.id)
      spaceId = (await services.schedulerService.getSchedule(params.id)).spaceId;
    if (path.startsWith('/api/workers/') && params.id) {
      const worker = await services.workerService.getWorker(params.id);
      const memberships = await services.membershipService.listMemberships(userId);
      if (!memberships.some((m) => worker.spaceIds.includes(m.spaceId)))
        throw unauthorized('Worker is outside your spaces');
      return;
    }
    if (spaceId) {
      await services.membershipService.requireMember(spaceId, userId);
      return;
    }
    if (
      path.startsWith('/api/memory') ||
      (req.method !== 'GET' && ['/api/tickets', '/api/sessions', '/api/schedules'].includes(path))
    )
      throw validation('spaceId is required');
  });
}
