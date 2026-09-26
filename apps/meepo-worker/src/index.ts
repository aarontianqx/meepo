import { SERVER_CHANNEL_EVENTS, type WorkerStreamEvent } from '@meepo/protocol';

import { SessionManager } from './agent/session-manager.js';
import { SlotSemaphore } from './agent/slot-semaphore.js';
import { TicketRunner } from './agent/ticket-runner.js';
import { WorkerClient } from './client.js';
import { loadConfig } from './config.js';

const config = loadConfig();
/** Worker-global bound on concurrently executing runs (session turns + tickets). */
const slots = new SlotSemaphore(config.maxSlots);

/** Upstream stream events; also drives the client's active-run bookkeeping. */
const emit = (event: WorkerStreamEvent): void => {
  if (event.type === 'run_started') client.runStarted(event.runId);
  if (event.type === 'run_completed' || event.type === 'run_failed') {
    client.runFinished(event.runId);
  }
  client.sendNotification(SERVER_CHANNEL_EVENTS.stream, event);
};

const reportDispatchFailure = (runId: string, err: unknown): void => {
  emit({ type: 'run_failed', runId, error: (err as Error).message, code: 'dispatch_failed' });
};

const sessionManager = new SessionManager({
  workerId: config.workerId,
  rpc: (method, params) => client.rpc(method, params),
  emit,
  sessionsDir: config.sessionsDir,
  sessionTtlMs: config.sessionTtlMs,
  slots,
});

const ticketRunner = new TicketRunner({
  workerId: config.workerId,
  emit,
  ticketsDir: config.ticketsDir,
  slots,
});

const client = new WorkerClient(config, {
  onTurnDispatch: (envelope) => {
    sessionManager.handleDispatch(envelope).catch((err) => {
      reportDispatchFailure(envelope.runId, err);
    });
  },
  onTicketDispatch: (envelope) => {
    ticketRunner.handleDispatch(envelope).catch((err) => {
      reportDispatchFailure(envelope.runId, err);
    });
  },
  onRunSteer: (payload) => sessionManager.handleSteer(payload),
  onRunAbort: (payload) => {
    sessionManager.handleAbort(payload);
    ticketRunner.handleAbort(payload);
  },
});

client.start();
sessionManager.startSweep();
console.log(`meepo-worker ${config.workerId} connecting to ${config.serverUrl} ...`);
