import { WebhookService } from './domain/webhooks/webhook-service.js';
import { SqliteWebhookTokenRepository } from './store/sqlite/webhook-token-sqlite.js';
import { SqliteInboundInbox } from './store/sqlite/inbound-inbox-sqlite.js';
import { ReplyOutbox } from './transport/feishu/reply-outbox.js';
import { SqliteMessageOutbox } from './store/sqlite/message-outbox-sqlite.js';
import { SqliteCardOutbox } from './store/sqlite/card-outbox-sqlite.js';
import { ModelService } from './domain/models/model-service.js';
import { SqliteModelRepository } from './store/sqlite/model-sqlite.js';
import { PromptService } from './domain/prompts/prompt-service.js';
import { MemoryService } from './domain/memory/memory-service.js';
import { SqliteMemoryRepository } from './store/sqlite/memory-sqlite.js';
import { WorkerConnectionHub } from './transport/ws/worker-connection-hub.js';
import { SessionLifecycle } from './domain/sessions/session-lifecycle.js';
import { SqliteSessionLifecycle } from './store/sqlite/session-lifecycle-sqlite.js';
import { ReceiptService } from './domain/tickets/receipt-service.js';
import { SqliteReceiptRepository } from './store/sqlite/receipt-sqlite.js';
import { SqliteFireCommitter } from './store/sqlite/fire-committer-sqlite.js';
import { ReliabilityService } from './domain/runs/reliability-service.js';
import { ChannelService } from './domain/channels/channel-service.js';
import { SqliteChannelRepository } from './store/sqlite/channel-sqlite.js';
import { SecretCodec } from './infra/secrets/secret-codec.js';
import { ChannelRuntime } from './transport/feishu/channel-runtime.js';
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
import { SqliteDispatchCommitter } from './store/sqlite/dispatch-committer-sqlite.js';
import { SqliteExecutionJournal } from './store/sqlite/execution-journal-sqlite.js';
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
export async function bootstrap(config: ServerConfig = loadConfig()): Promise<ServerRuntime> {
  const db = openDatabase(config.dbPath);
  const membershipRepository = new SqliteMembershipRepository(db);
  const enrollmentTokens = new SqliteEnrollmentTokenRepository(db);
  const spaceRepository = new SqliteSpaceRepository(db);
  const codec = new SecretCodec(config.secretKey, config.production);
  const modelService = new ModelService(config.models, new SqliteModelRepository(db, codec));
  const channelService = new ChannelService(
    new SqliteChannelRepository(db, codec),
    spaceRepository
  );
  await channelService.importEnvironment(config.feishu);
  const workerRepository = new SqliteWorkerRepository(db);
  const ticketRepository = new SqliteTicketRepository(db);
  const sessionRepository = new SqliteSessionRepository(db);
  const sessionEvents = new SqliteSessionEventRepository(db);
  const scheduleRepository = new SqliteScheduleRepository(db);
  const runRepository = new SqliteRunRepository(db);
  const dispatchQueue = new SqliteDispatchQueueRepository(db);

  const connections = new WorkerConnectionHub();
  const lifecycle: SessionLifecycle = new SessionLifecycle(
    new SqliteSessionLifecycle(db),
    connections,
    (run) => streamProcessor.renderInterrupted(run)
  );
  const memoryService = new MemoryService(new SqliteMemoryRepository(db));
  const membershipService = new MembershipService(membershipRepository);
  const spaceService = new SpaceService(
    spaceRepository,
    membershipService,
    workerRepository,
    lifecycle,
    lifecycle
  );
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
  const sessionService = new SessionService(sessionRepository, spaceRepository, lifecycle);
  const schedulerService = new SchedulerService(
    scheduleRepository,
    sessionRepository,
    spaceRepository,
    new SqliteFireCommitter(db)
  );
  const transcriptService = new TranscriptService(sessionEvents, sessionRepository);
  const journal = new SqliteExecutionJournal(db);
  const reliability = new ReliabilityService(runRepository, ticketRepository, journal);
  const streamProcessor: StreamProcessor = new StreamProcessor(
    transcriptService,
    ticketService,
    runRepository,
    console,
    journal,
    Date.now,
    (event, ref) => channelRuntime.render(event, ref),
    (id, text) => {
      void channelRuntime.notify(id, text);
    }
  );

  const dispatchService = new DispatchService(
    sessionRepository,
    spaceRepository,
    workerRepository,
    ticketRepository,
    runRepository,
    dispatchQueue,
    connections,
    transcriptService,
    config.models,
    new SqliteDispatchCommitter(db),
    Date.now,
    config.heartbeatIntervalSeconds * 3_000,
    (run) => streamProcessor.renderInterrupted(run),
    (id) => {
      const channel = channelService.get(id);
      return { appId: channel.appId, appSecret: channel.appSecret };
    },
    journal
  );
  const receiptService = new ReceiptService(
    new SqliteReceiptRepository(db),
    sessionRepository,
    dispatchService
  );
  const workerChannel = new WorkerChannelHandler({
    runRepository,
    workerService,
    schedulerService,
    sessionService,
    ticketService,
    transcriptService,
    streamProcessor,
    connections,
    dispatchService,
    memoryService,
    promptService: new PromptService(
      spaceRepository,
      sessionRepository,
      transcriptService,
      memoryService
    ),
    onWorkerReady: (workerId) => {
      void dispatchService.flushWorkerQueues(workerId).catch((err) => app.log.error(err));
    },
  });

  const services: ServiceContainer = {
    webhookService: new WebhookService(new SqliteWebhookTokenRepository(db)),
    runRepository,
    executionJournal: journal,
    memoryService,
    modelService,
    channelService,
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

  const authenticator = new HeaderAuthenticator();
  const app = await buildHttpServer({ config, services, workerChannel, authenticator });

  const channelRuntime: ChannelRuntime = new ChannelRuntime(
    channelService,
    sessionService,
    async (channel) => {
      const larkClient = createLarkClient(channel);
      const feishuClient = new LarkFeishuClient(larkClient);
      const replyOutbox = new ReplyOutbox(channel.id, new SqliteMessageOutbox(db), feishuClient);
      const cardOutbox = new SqliteCardOutbox(db);
      cardOutbox.reconcile(channel.id);
      const cardStreamer = new CardStreamer({
        client: feishuClient,
        sessions: sessionService,
        channelId: channel.id,
        outbox: cardOutbox,
        isUserRun: async (id) => !!(await runRepository.getById(id))?.initiatorIds?.length,
        onError: (err) => app.log.error(err, 'feishu card streaming failed'),
      });
      const feishuGateway = new FeishuGateway({
        inbox: new SqliteInboundInbox(db),
        client: feishuClient,
        sessionService,
        dispatchService,
        transcriptService,
        spaces: spaceRepository,
        runs: runRepository,
        botOpenId: await fetchBotOpenId(larkClient),
        channelId: channel.id,
        channelSpaceId: channel.spaceId,
        defaultSpaceId: channel.spaceId,
        allowedOpenIds: channel.allowedOpenIds,
        boundChatIds: channel.boundChatIds,
        onError: (err) => app.log.error(err, 'feishu gateway failed'),
      });
      const connection = startFeishuWs(
        channel,
        (event) => feishuGateway.handleEvent(event),
        (event) => feishuGateway.handleCardAction(event)
      );
      cardStreamer.recover();
      const recoverTimer = setInterval(() => {
        cardOutbox.reconcile(channel.id);
        cardStreamer.recover();
        void feishuGateway.recover();
        void replyOutbox.flush().catch((error) => app.log.error(error));
      }, 2000);
      recoverTimer.unref();
      return {
        stop: () => {
          clearInterval(recoverTimer);
          cardStreamer.stop();
          connection.close();
        },
        render: cardStreamer.handleEvent,
        notify: (sessionId, text) => feishuGateway.notifySession(sessionId, text),
      };
    },
    (err) => app.log.error(err, 'channel connection failed')
  );
  await channelRuntime.sync();
  const channelTimer = setInterval(() => {
    void channelRuntime.sync().catch((err) => app.log.error(err));
  }, 2_000);
  channelTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(channelTimer);
    channelRuntime.stop();
  });

  const retentionTimer = setInterval(() => {
    db.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(
      Date.now() - 7 * 86400000
    );
  }, 3600000);
  retentionTimer.unref();
  const sweepTimer = setInterval(
    () => void workerService.sweepStale(),
    Math.max(1_000, Math.floor(config.workerOfflineAfterMs / 2))
  );
  sweepTimer.unref();

  let ticking = false;
  const fireTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void reliability
      .sweep()
      .then(() => receiptService.flush())
      .then(() => fireDueSchedules(schedulerService, dispatchService, ticketService))
      .catch((err: unknown) => {
        app.log.error(err, 'scheduler fire loop failed');
      })
      .finally(() => {
        ticking = false;
      });
  }, 1_000);
  fireTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    clearInterval(sweepTimer);
    clearInterval(fireTimer);
    db.close();
  });

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
  for (const fire of scheduler.atomicFires ? [] : fires) {
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
  await dispatch.flushConnectedQueues();
  await dispatch.dispatchPendingTickets();
}
