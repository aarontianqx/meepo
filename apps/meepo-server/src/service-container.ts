import type { Dispatcher } from './domain/dispatch/dispatcher.js';
import type { EnrollmentService } from './domain/enrollments/enrollment-service.js';
import type { MembershipService } from './domain/memberships/membership-service.js';
import type { SessionService } from './domain/sessions/session-service.js';
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
  dispatcher: Dispatcher;
}
