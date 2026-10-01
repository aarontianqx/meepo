import { watchFile, unwatchFile } from 'node:fs';
import { McpManager } from './agent/mcp.js';
import { readWorkerFile } from './config.js';
import { type WorkerStreamEvent } from '@meepo/protocol';

import { SessionManager } from './agent/session-manager.js';
import { SlotSemaphore } from './agent/slot-semaphore.js';
import { TicketRunner } from './agent/ticket-runner.js';
import { WorkerClient } from './client.js';
import { loadConfig } from './config.js';

const config = loadConfig();
let modelDefaults = config.modelDefaults;
const mcp = new McpManager();
await mcp.reload(config.mcp ?? {});
let reloading = false;
if (config.configPath)
  watchFile(config.configPath, { interval: 2000, persistent: false }, () => {
    if (reloading) return;
    reloading = true;
    void Promise.resolve()
      .then(() => readWorkerFile(config.configPath!))
      .then(async (next) => {
        const level = process.env.MEEPO_THINKING_LEVEL ?? next.modelDefaults?.thinkingLevel;
        if (level && !['low', 'high', 'max'].includes(level))
          throw new Error('Invalid default thinkingLevel');
        await mcp.reload(next.mcp ?? {});
        modelDefaults = { thinkingLevel: level as 'low' | 'high' | 'max' | undefined };
      })
      .catch((error) => console.error('MCP reload rejected; retaining previous tools', error))
      .finally(() => {
        reloading = false;
      });
  });

/** Worker-global bound on concurrently executing runs (session turns + tickets). */
const slots = new SlotSemaphore(config.maxSlots);

/** Upstream stream events; also drives the client's active-run bookkeeping. */
const emit = (event: WorkerStreamEvent): void => {
  if (event.type === 'run_started') client.runStarted(event.runId);
  if (['run_completed', 'run_failed', 'run_merged', 'run_dropped'].includes(event.type)) {
    client.runFinished(event.runId);
  }
  client.sendStreamEvent(event);
};

const reportDispatchFailure = (runId: string, err: unknown): void => {
  emit({ type: 'run_failed', runId, error: (err as Error).message, code: 'dispatch_failed' });
};

const sessionManager = new SessionManager({
  workerId: config.workerId,
  acquireTools: () => mcp.acquire(),
  rpc: (method, params) => client.rpc(method, params),
  emit,
  sessionsDir: config.sessionsDir,
  sessionTtlMs: config.sessionTtlMs,
  slots,
  beforeExecution: (runId) => client.beforeExecution(runId),
});

const ticketRunner = new TicketRunner({
  rpc: (method, params) => client.rpc(method, params),
  workerId: config.workerId,
  acquireTools: () => mcp.acquire(),
  emit,
  ticketsDir: config.ticketsDir,
  slots,
  beforeExecution: (runId) => client.beforeExecution(runId),
});

const client = new WorkerClient(config, {
  onTurnDispatch: (envelope) => {
    sessionManager
      .handleDispatch({
        ...envelope,
        model: {
          ...modelDefaults,
          ...envelope.model,
          thinkingLevel: envelope.model.thinkingLevel ?? modelDefaults?.thinkingLevel,
        },
      })
      .catch((err) => {
        reportDispatchFailure(envelope.runId, err);
      });
  },
  onTicketDispatch: (envelope) => {
    ticketRunner
      .handleDispatch({
        ...envelope,
        model: {
          ...envelope.model,
          thinkingLevel: envelope.model.thinkingLevel ?? modelDefaults?.thinkingLevel,
        },
      })
      .catch((err) => {
        reportDispatchFailure(envelope.runId, err);
      });
  },
  onContextAppend: (payload) => sessionManager.handleContextAppend(payload),
  onSessionClosed: (id) => {
    void sessionManager.closeSession(id);
  },
  onRunSteer: (payload) => sessionManager.handleSteer(payload),
  onRunAbort: (payload) => {
    sessionManager.handleAbort(payload);
    ticketRunner.handleAbort(payload);
  },
});

const retentionTimer = setInterval(() => {
  void ticketRunner.reclaim().catch((error) => console.error('Ticket cleanup failed', error));
}, 60000);
retentionTimer.unref();
await ticketRunner.reclaim();
client.start();
sessionManager.startSweep();
console.log(`meepo-worker ${config.workerId} connecting to ${config.serverUrl} ...`);

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    if (config.configPath) unwatchFile(config.configPath);
    clearInterval(retentionTimer);
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void Promise.allSettled([sessionManager.shutdown(), ticketRunner.shutdown()])
      .then(() => client.stop())
      .then(() => mcp.close())
      .finally(() => process.exit(0));
  });
