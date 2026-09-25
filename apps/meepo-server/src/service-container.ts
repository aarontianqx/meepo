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
