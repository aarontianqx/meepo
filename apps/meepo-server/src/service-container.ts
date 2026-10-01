import type { WebhookService } from './domain/webhooks/webhook-service.js';
import type { RunRepository } from './domain/runs/run-repository.js';
import type { ExecutionJournal } from './domain/runs/execution-journal.js';
import type { ModelService } from './domain/models/model-service.js';
import type { MemoryService } from './domain/memory/memory-service.js';
import type { ChannelService } from './domain/channels/channel-service.js';
import type { DispatchService } from './domain/dispatch/dispatch-service.js';
import type { EnrollmentService } from './domain/enrollments/enrollment-service.js';
import type { MembershipService } from './domain/memberships/membership-service.js';
import type { SchedulerService } from './domain/schedule/scheduler-service.js';
import type { SessionService } from './domain/sessions/session-service.js';
import type { TranscriptService } from './domain/sessions/transcript-service.js';
import type { SpaceService } from './domain/spaces/space-service.js';
import type { TicketService } from './domain/tickets/ticket-service.js';
import type { WorkerService } from './domain/workers/worker-service.js';

/** Domain services exposed to transport layers, assembled in bootstrap. */
export interface ServiceContainer {
  webhookService?: WebhookService;
  runRepository?: RunRepository;
  executionJournal?: ExecutionJournal;
  modelService?: ModelService;
  memoryService?: MemoryService;
  channelService?: ChannelService;
  membershipService: MembershipService;
  spaceService: SpaceService;
  enrollmentService: EnrollmentService;
  workerService: WorkerService;
  ticketService: TicketService;
  sessionService: SessionService;
  schedulerService: SchedulerService;
  transcriptService: TranscriptService;
  dispatchService: DispatchService;
}
