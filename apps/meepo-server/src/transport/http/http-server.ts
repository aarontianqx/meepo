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
import { registerHealthRoutes } from './routes/health.js';
import { registerMembershipRoutes } from './routes/memberships.js';
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
      return reply
        .status(DOMAIN_ERROR_STATUS[err.code])
        .send({ error: { code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (req) => {
    req.identity = await options.authenticator.authenticate(req.headers);
  });

  registerHealthRoutes(app);
  registerMembershipRoutes(app, options.services);
  registerSpaceRoutes(app, options.services);
  registerWorkerRoutes(app, options.services);
  registerTicketRoutes(app, options.services);

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
