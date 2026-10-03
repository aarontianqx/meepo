import { registerObservationRoutes } from './routes/observation.js';
import { registerAuthorization } from './authorization.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { MemoryError } from '../../domain/memory/memory-service.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { WORKER_CHANNEL_PATH } from '@meepo/protocol';

import type { ServerConfig } from '../../config.js';
import { DomainError } from '../../domain/errors.js';
import type { Authenticator } from '../../domain/identity/authenticator.js';
import type { ServiceContainer } from '../../service-container.js';
import type { WorkerChannelHandler } from '../ws/worker-channel.js';
import './auth.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMembershipRoutes } from './routes/memberships.js';
import { registerModelRoutes } from './routes/models.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSpaceRoutes } from './routes/spaces.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerWorkerRoutes } from './routes/workers.js';

export interface HttpServerOptions {
  config: ServerConfig;
  services: ServiceContainer;
  workerChannel: WorkerChannelHandler;
  authenticator: Authenticator;
}

const DOMAIN_ERROR_STATUS: Record<DomainError['code'], number> = {
  validation: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
};

export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(DOMAIN_ERROR_STATUS[err.code]).send({
        error: {
          code: err instanceof MemoryError ? err.memoryCode : err.code,
          message: err.message,
          ...(err instanceof MemoryError ? { currentRevision: err.currentRevision } : {}),
        },
      });
    }
    if ((err as { statusCode?: number }).statusCode === 413)
      return reply
        .status(413)
        .send({ error: { code: 'payload_too_large', message: 'Request body exceeds the limit' } });
    if ((err as { statusCode?: number }).statusCode === 400)
      return reply
        .status(400)
        .send({ error: { code: 'validation', message: 'Invalid request body' } });
    app.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (req) => {
    req.identity = await options.authenticator.authenticate(req.headers);
  });

  app.addHook('preValidation', async (req) => {
    if (
      req.url.startsWith('/api/') &&
      ['POST', 'PUT', 'PATCH'].includes(req.method) &&
      (req.body === null ||
        (req.body !== undefined && (typeof req.body !== 'object' || Array.isArray(req.body))))
    )
      throw new DomainError('validation', 'JSON object body required');
    if (
      req.url.startsWith('/api/') &&
      ['POST', 'PUT', 'PATCH'].includes(req.method) &&
      req.body === undefined
    )
      req.body = {};
  });
  registerAuthorization(app, options.services, options.config.adminUserIds ?? []);
  registerHealthRoutes(app);
  if (options.services.runRepository) registerObservationRoutes(app, options.services);
  if (options.services.memoryService) registerMemoryRoutes(app, options.services);
  if (options.services.channelService)
    registerChannelRoutes(app, options.services.channelService, options.config.adminUserIds ?? []);
  registerMembershipRoutes(app, options.services);
  registerSpaceRoutes(app, options.services);
  registerWorkerRoutes(app, options.services);
  registerModelRoutes(app, options.config.models, options.services.modelService);
  registerTicketRoutes(app, options.services);
  registerSessionRoutes(app, options.services);
  registerScheduleRoutes(app, options.services);

  await app.register(async (scope) => {
    scope.get(WORKER_CHANNEL_PATH, { websocket: true }, (socket) => {
      options.workerChannel.handleConnection(socket);
    });
  });

  const consoleDist = options.config.consoleDistPath ?? defaultConsoleDistPath();
  if (existsSync(consoleDist)) {
    await app.register(fastifyStatic, { root: consoleDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    });
    app.log.info(`serving console from ${consoleDist}`);
  }

  return app;
}

/** Built SPA of apps/meepo-console, when running inside the monorepo. */
function defaultConsoleDistPath(): string {
  return fileURLToPath(new URL('../../../../meepo-console/dist/', import.meta.url));
}
