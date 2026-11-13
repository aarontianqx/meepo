import type { FastifyInstance } from 'fastify';

import { identityOf } from '../auth.js';

/** The caller's resolved identity and whether it holds the global administrator role. */
export function registerMeRoutes(app: FastifyInstance, adminUserIds: string[]): void {
  app.get('/api/me', async (req) => {
    const identity = identityOf(req);
    return {
      userId: identity.userId,
      displayName: identity.displayName,
      isAdmin: adminUserIds.includes(identity.userId),
    };
  });
}
