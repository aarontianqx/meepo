import type { FastifyInstance } from 'fastify';

import { loadConfig, type ServerConfig } from './config.js';
import { DispatchService } from './domain/dispatch/dispatch-service.js';
import { EnrollmentService } from './domain/enrollments/enrollment-service.js';
import { MembershipService } from './domain/memberships/membership-service.js';
import { SchedulerService } from './domain/schedule/scheduler-service.js';
import { SessionService } from './domain/sessions/session-service.js';
import { StreamProcessor } from './domain/sessions/stream-processor.js';
import { TranscriptService } from './domain/sessions/transcript-service.js';
import { SpaceService } from './domain/spaces/space-service.js';
import { TicketService } from './domain/tickets/ticket-service.js';
import { WorkerService } from './domain/workers/worker-service.js';
import { HeaderAuthenticator } from './infra/auth/header-authenticator.js';
import type { ServiceContainer } from './service-container.js';
import { openDatabase } from './store/sqlite/database.js';
import { SqliteDispatchQueueRepository } from './store/sqlite/dispatch-queue-sqlite.js';
import { SqliteEnrollmentTokenRepository } from './store/sqlite/enrollment-sqlite.js';
import { SqliteMembershipRepository } from './store/sqlite/membership-sqlite.js';
import { SqliteRunRepository } from './store/sqlite/run-sqlite.js';
import { SqliteScheduleRepository } from './store/sqlite/schedule-sqlite.js';
import { SqliteSessionEventRepository } from './store/sqlite/session-event-sqlite.js';
import { SqliteSessionRepository } from './store/sqlite/session-sqlite.js';
import { SqliteSpaceRepository } from './store/sqlite/space-sqlite.js';
import { SqliteTicketRepository } from './store/sqlite/ticket-sqlite.js';
import { SqliteWorkerRepository } from './store/sqlite/worker-sqlite.js';
import { CardStreamer } from './transport/feishu/card-streamer.js';
import {
  createLarkClient,
  fetchBotOpenId,
  LarkFeishuClient,
  startFeishuWs,
} from './transport/feishu/feishu-client.js';
import { FeishuGateway } from './transport/feishu/feishu-gateway.js';
import { buildHttpServer } from './transport/http/http-server.js';
import { WorkerChannelHandler } from './transport/ws/worker-channel.js';

export interface ServerRuntime {
  app: FastifyInstance;
  config: ServerConfig;
  services: ServiceContainer;
  dispatchService: DispatchService;
  schedulerService: SchedulerService;
}

/** Composition root: wires config -> stores -> domain services -> transports. */
export async function bootstrap(): Promise<ServerRuntime> {
  const config = loadConfig();

  const db = openDatabase(config.dbPath);
  const membershipRepository = new SqliteMembershipRepository(db);
  const enrollmentTokens = new SqliteEnrollmentTokenRepository(db);
  const spaceRepository = new SqliteSpaceRepository(db);
  const workerRepository = new SqliteWorkerRepository(db);
  const ticketRepository = new SqliteTicketRepository(db);
  const sessionRepository = new SqliteSessionRepository(db);
  const sessionEvents = new SqliteSessionEventRepository(db);
  const scheduleRepository = new SqliteScheduleRepository(db);
  const runRepository = new SqliteRunRepository(db);
  const dispatchQueue = new SqliteDispatchQueueRepository(db);

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
  const schedulerService = new SchedulerService(
    scheduleRepository,
    sessionRepository,
    spaceRepository
  );
  const transcriptService = new TranscriptService(sessionEvents, sessionRepository);
  const streamProcessor = new StreamProcessor(transcriptService, ticketService, runRepository);

  const workerChannel = new WorkerChannelHandler({
    workerService,
    schedulerService,
    sessionService,
    ticketService,
    transcriptService,
    streamProcessor,
  });
  const dispatchService = new DispatchService(
    sessionRepository,
    spaceRepository,
    workerRepository,
    ticketRepository,
    runRepository,
    dispatchQueue,
    workerChannel,
    transcriptService,
    config.defaultModel
  );
  workerChannel.setDispatchService(dispatchService);

  const services: ServiceContainer = {
    membershipService,
    spaceService,
    enrollmentService,
    workerService,
    ticketService,
    sessionService,
    schedulerService,
    transcriptService,
    dispatchService,
  };

  workerChannel.setOnWorkerReady((workerId) => {
    void dispatchService.flushWorkerQueues(workerId).catch((err: unknown) => {
      app.log.error(err, `failed to flush queues for worker ${workerId}`);
    });
  });

  const authenticator = new HeaderAuthenticator();
  const app = await buildHttpServer({ config, services, workerChannel, authenticator });

  if (config.feishu) {
    try {
      const larkClient = createLarkClient(config.feishu);
      const feishuClient = new LarkFeishuClient(larkClient);
      const cardStreamer = new CardStreamer({
        client: feishuClient,
        sessions: sessionService,
        onError: (err) => app.log.error(err, 'feishu card streaming failed'),
      });
      streamProcessor.setRenderHook(cardStreamer.handleEvent);
      const botOpenId = await fetchBotOpenId(larkClient);
      const feishuGateway = new FeishuGateway({
        client: feishuClient,
        sessionService,
        dispatchService,
        transcriptService,
        spaces: spaceRepository,
        botOpenId,
        defaultSpaceId: config.feishu.defaultSpaceId,
        onError: (err) => app.log.error(err, 'feishu gateway message handling failed'),
      });
      streamProcessor.setTicketResultNotifier((sessionId, text) => {
        void feishuGateway.notifySession(sessionId, text);
      });
      startFeishuWs(config.feishu, (event) => feishuGateway.handleEvent(event));
      app.log.info('feishu gateway started');
    } catch (err: unknown) {
      app.log.error(err, 'feishu gateway failed to start; continuing without it');
    }
  }

  const sweepTimer = setInterval(
    () => void workerService.sweepStale(),
    Math.max(1_000, Math.floor(config.workerOfflineAfterMs / 2))
  );
  sweepTimer.unref();

  const fireTimer = setInterval(() => {
    void fireDueSchedules(schedulerService, dispatchService, ticketService).catch(
      (err: unknown) => {
        app.log.error(err, 'scheduler fire loop failed');
      }
    );
  }, 1_000);
  fireTimer.unref();

  return { app, config, services, dispatchService, schedulerService };
}

/**
 * Scheduler fire loop: `resume_session` fires wake their session, `create_ticket`
 * fires materialize a ticket (linked back to its origin session) and dispatch it.
 */
async function fireDueSchedules(
  scheduler: SchedulerService,
  dispatch: DispatchService,
  tickets: TicketService
): Promise<void> {
  const fires = await scheduler.collectDueFires();
  for (const fire of fires) {
    const { schedule } = fire;
    if (schedule.action.kind === 'resume_session') {
      await dispatch.dispatchSessionTurn({
        sessionId: schedule.action.sessionId,
        prompt: schedule.action.prompt,
        source: {
          kind: 'schedule',
          scheduleId: schedule.id,
          coalescedCount: fire.coalescedCount,
          stale: fire.stale,
        },
        delivery: 'wait',
      });
      continue;
    }
    const action = schedule.action;
    const ticket = await tickets.createTicket({
      spaceId: schedule.spaceId,
      title: action.objective.slice(0, 80),
      objective: action.objective,
      contextSummary: action.contextSummary,
      requiredTags: action.requiredTags,
      originSessionId: action.originSessionId,
    });
    await dispatch.dispatchTicket(ticket.id);
  }
  await dispatch.dispatchPendingTickets();
}
