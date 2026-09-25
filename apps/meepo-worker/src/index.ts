import { SERVER_CHANNEL_EVENTS, type WorkerStreamEvent } from '@meepo/protocol';

import { SessionManager } from './agent/session-manager.js';
import { TicketRunner } from './agent/ticket-runner.js';
import { WorkerClient } from './client.js';
import { loadConfig } from './config.js';

const config = loadConfig();

/** Upstream stream events; also drives the client's active-task bookkeeping. */
const emit = (event: WorkerStreamEvent): void => {
  if (event.type === 'task_started') client.taskStarted(event.taskId);
  if (event.type === 'task_completed' || event.type === 'task_failed') {
    client.taskFinished(event.taskId);
  }
  client.sendNotification(SERVER_CHANNEL_EVENTS.stream, event);
};

const reportDispatchFailure = (taskId: string, err: unknown): void => {
  emit({ type: 'task_failed', taskId, error: (err as Error).message, code: 'dispatch_failed' });
};

const sessionManager = new SessionManager({
  workerId: config.workerId,
  rpc: (method, params) => client.rpc(method, params),
  emit,
  sessionsDir: config.sessionsDir,
  sessionTtlMs: config.sessionTtlMs,
});

const ticketRunner = new TicketRunner({
  workerId: config.workerId,
  emit,
  ticketsDir: config.ticketsDir,
});

const client = new WorkerClient(config, {
  onSessionDispatch: (envelope) => {
    sessionManager.handleDispatch(envelope).catch((err) => {
      reportDispatchFailure(envelope.taskId, err);
    });
  },
  onTicketDispatch: (envelope) => {
    ticketRunner.handleDispatch(envelope).catch((err) => {
      reportDispatchFailure(envelope.taskId, err);
    });
  },
  onTaskSteer: (payload) => sessionManager.handleSteer(payload),
  onTaskAbort: (payload) => {
    sessionManager.handleAbort(payload);
    ticketRunner.handleAbort(payload);
  },
});

client.start();
sessionManager.startSweep();
console.log(`meepo-worker ${config.workerId} connecting to ${config.serverUrl} ...`);
