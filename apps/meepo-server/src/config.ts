export interface ServerConfig {
  host: string;
  port: number;
  /** Interval the server asks workers to heartbeat at (advertised on registration) */
  heartbeatIntervalSeconds: number;
  /** Workers without a heartbeat within this window are marked offline */
  workerOfflineAfterMs: number;
  /** Directory of the built console SPA; static hosting is skipped when absent */
  consoleDistPath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MEEPO_HOST ?? '0.0.0.0',
    port: Number(env.MEEPO_PORT ?? 8780),
    heartbeatIntervalSeconds: Number(env.MEEPO_HEARTBEAT_INTERVAL_SECONDS ?? 15),
    workerOfflineAfterMs: Number(env.MEEPO_WORKER_OFFLINE_AFTER_MS ?? 45_000),
    consoleDistPath: env.MEEPO_CONSOLE_DIST,
  };
}
