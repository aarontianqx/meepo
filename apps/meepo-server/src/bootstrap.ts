import type { FastifyInstance } from 'fastify';

import { loadConfig, type ServerConfig } from './config.js';
import { Dispatcher } from './domain/dispatch/dispatcher.js';
import { EnrollmentService } from './domain/enrollments/enrollment-service.js';
import { MembershipService } from './domain/memberships/membership-service.js';
import { SessionService } from './domain/sessions/session-service.js';
import { SpaceService } from './domain/spaces/space-service.js';
import { TicketService } from './domain/tickets/ticket-service.js';
import { WorkerService } from './domain/workers/worker-service.js';
import { HeaderAuthenticator } from './infra/auth/header-authenticator.js';
import type { ServiceContainer } from './service-container.js';
import { MemoryEnrollmentTokenRepository } from './store/memory/enrollment-memory.js';
import { MemoryMembershipRepository } from './store/memory/membership-memory.js';
import { MemorySessionRepository } from './store/memory/session-memory.js';
import { MemorySpaceRepository } from './store/memory/space-memory.js';
import { MemoryTicketRepository } from './store/memory/ticket-memory.js';
import { MemoryWorkerRepository } from './store/memory/worker-memory.js';
import { buildHttpServer } from './transport/http/http-server.js';
import { WorkerChannelHandler } from './transport/ws/worker-channel.js';

export interface ServerRuntime {
  app: FastifyInstance;
  config: ServerConfig;
  services: ServiceContainer;
}

/** Composition root: wires config -> stores -> domain services -> transports. */
export async function bootstrap(): Promise<ServerRuntime> {
  const config = loadConfig();

  const membershipRepository = new MemoryMembershipRepository();
  const enrollmentTokens = new MemoryEnrollmentTokenRepository();
  const spaceRepository = new MemorySpaceRepository();
  const workerRepository = new MemoryWorkerRepository();
  const ticketRepository = new MemoryTicketRepository();
  const sessionRepository = new MemorySessionRepository();

  const membershipService = new MembershipService(membershipRepository);
  const spaceService = new SpaceService(spaceRepository, membershipService, workerRepository);
  const enrollmentService = new EnrollmentService(
    enrollmentTokens,
    spaceRepository,
    membershipService
  );
  const workerService = new WorkerService(workerRepository, enrollmentService, spaceService, {
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    workerOfflineAfterMs: config.workerOfflineAfterMs,
  });
  const ticketService = new TicketService(ticketRepository, spaceRepository);
  const sessionService = new SessionService(sessionRepository, spaceRepository);
  const dispatcher = new Dispatcher(workerRepository, spaceRepository);

  const services: ServiceContainer = {
    membershipService,
    spaceService,
    enrollmentService,
    workerService,
    ticketService,
    sessionService,
    dispatcher,
  };

  const workerChannel = new WorkerChannelHandler(workerService);
  const authenticator = new HeaderAuthenticator();
  const app = await buildHttpServer({ config, services, workerChannel, authenticator });

  const sweepTimer = setInterval(
    () => void workerService.sweepStale(),
    Math.max(1_000, Math.floor(config.workerOfflineAfterMs / 2))
  );
  sweepTimer.unref();

  return { app, config, services };
}
