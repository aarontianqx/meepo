import { isTerminalRun } from '@meepo/core';
import type { RunRepository } from './run-repository.js';
import type { ExecutionJournal } from './execution-journal.js';
import type { TicketRepository } from '../tickets/ticket-repository.js';

/** Lease expiry never implies permission to repeat an unknown side effect. */
export class ReliabilityService {
  constructor(
    private readonly runs: RunRepository,
    private readonly tickets: TicketRepository,
    private readonly journal: ExecutionJournal,
    private readonly now: () => number = Date.now
  ) {}

  async sweep(): Promise<void> {
    const now = this.now();
    for (const run of await this.runs.list({ expiredBefore: now })) {
      if (isTerminalRun(run.status) || !run.leaseExpiresAt || run.leaseExpiresAt > now) continue;
      run.status = 'failed';
      run.terminalReason = run.startedAt === undefined ? 'worker_lost' : 'lease_lost';
      run.completedAt = now;
      if (run.work.kind !== 'ticket') {
        this.journal.TxExpire(run);
        continue;
      }
      const ticket = await this.tickets.getById(run.work.ticketId);
      if (
        !ticket ||
        !['claimed', 'running'].includes(ticket.status) ||
        ticket.attempt !== run.attempt
      ) {
        this.journal.TxExpire(run);
        continue;
      }
      const calls = this.journal.listByRun(run.id).filter((e) => e.type === 'tool_call');
      const safe =
        run.startedAt === undefined ||
        ticket.idempotent ||
        calls.every((e) =>
          ['read', 'grep', 'ls', 'glob'].includes((e.payload as { toolName: string }).toolName)
        );
      ticket.status = run.attempt >= 3 ? 'failed' : safe ? 'pending' : 'manual_review';
      ticket.terminalReason = run.attempt >= 3 ? 'max_attempts' : undefined;
      ticket.assignedWorkerId = undefined;
      ticket.updatedAt = now;
      if (ticket.status === 'pending') ticket.pendingSince = now;
      if (ticket.status === 'failed') ticket.completedAt = now;
      this.journal.TxExpire(run, ticket);
    }
    for (const ticket of await this.tickets.listPending(now - 86_400_000)) {
      if (now - ticket.pendingSince < 86_400_000) continue;
      ticket.status = 'failed';
      ticket.terminalReason = 'unclaimed';
      ticket.completedAt = now;
      ticket.updatedAt = now;
      await this.tickets.save(ticket, { status: 'pending', attempt: ticket.attempt ?? 0 });
    }
  }
}
