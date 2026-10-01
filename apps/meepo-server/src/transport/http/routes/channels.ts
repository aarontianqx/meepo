import type { FastifyInstance } from 'fastify';
import {
  publicChannel,
  type ChannelService,
  type Channel,
} from '../../../domain/channels/channel-service.js';
import { unauthorized } from '../../../domain/errors.js';
import { identityOf } from '../auth.js';

export function registerChannelRoutes(
  app: FastifyInstance,
  channels: ChannelService,
  adminUserIds: string[]
): void {
  const requireAdmin = (id: string): void => {
    if (!adminUserIds.includes(id)) throw unauthorized('Global admin role required');
  };
  app.get('/api/channels', async (req) => {
    requireAdmin(identityOf(req).userId);
    return channels.list().map(publicChannel);
  });
  app.post<{ Body: Omit<Channel, 'id' | 'updatedAt'> }>('/api/channels', async (req, reply) => {
    requireAdmin(identityOf(req).userId);
    return reply.status(201).send(
      publicChannel(
        await channels.save({
          ...req.body,
          allowedOpenIds: req.body.allowedOpenIds ?? [],
          boundChatIds: req.body.boundChatIds ?? [],
        })
      )
    );
  });
  app.patch<{ Params: { id: string }; Body: Partial<Channel> }>(
    '/api/channels/:id',
    async (req) => {
      requireAdmin(identityOf(req).userId);
      const old = channels.get(req.params.id);
      return publicChannel(
        await channels.save({
          ...old,
          ...req.body,
          id: old.id,
          appSecret: req.body.appSecret || old.appSecret,
        })
      );
    }
  );
  app.delete<{ Params: { id: string } }>('/api/channels/:id', async (req) => {
    requireAdmin(identityOf(req).userId);
    channels.delete(req.params.id);
    return { deleted: true };
  });
}
