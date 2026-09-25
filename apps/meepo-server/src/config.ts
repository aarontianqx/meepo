import type { ModelConfig } from '@meepo/protocol';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** Fallback space for private chats */
  defaultSpaceId?: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Interval the server asks workers to heartbeat at (advertised on registration) */
  heartbeatIntervalSeconds: number;
  /** Workers without a heartbeat within this window are marked offline */
  workerOfflineAfterMs: number;
  /** SQLite database file path */
  dbPath: string;
  /** Fallback model credentials when a space has none configured */
  defaultModel?: ModelConfig;
  /** Directory of the built console SPA; static hosting is skipped when absent */
  consoleDistPath?: string;
  /** Feishu app credentials; the gateway stays off when absent */
  feishu?: FeishuConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MEEPO_HOST ?? '0.0.0.0',
    port: Number(env.MEEPO_PORT ?? 8780),
    heartbeatIntervalSeconds: Number(env.MEEPO_HEARTBEAT_INTERVAL_SECONDS ?? 15),
    workerOfflineAfterMs: Number(env.MEEPO_WORKER_OFFLINE_AFTER_MS ?? 45_000),
    dbPath: env.MEEPO_DB_PATH ?? '.meepo/meepo.db',
    defaultModel: loadDefaultModel(env),
    consoleDistPath: env.MEEPO_CONSOLE_DIST,
    feishu: loadFeishuConfig(env),
  };
}

function loadFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | undefined {
  const { MEEPO_FEISHU_APP_ID, MEEPO_FEISHU_APP_SECRET, MEEPO_DEFAULT_SPACE_ID } = env;
  if (!MEEPO_FEISHU_APP_ID || !MEEPO_FEISHU_APP_SECRET) return undefined;
  return {
    appId: MEEPO_FEISHU_APP_ID,
    appSecret: MEEPO_FEISHU_APP_SECRET,
    defaultSpaceId: MEEPO_DEFAULT_SPACE_ID,
  };
}

function loadDefaultModel(env: NodeJS.ProcessEnv): ModelConfig | undefined {
  const { MEEPO_MODEL_PROVIDER, MEEPO_MODEL_BASE_URL, MEEPO_MODEL_API_KEY, MEEPO_MODEL_ID } = env;
  if (!MEEPO_MODEL_PROVIDER || !MEEPO_MODEL_BASE_URL || !MEEPO_MODEL_API_KEY || !MEEPO_MODEL_ID) {
    return undefined;
  }
  return {
    provider: MEEPO_MODEL_PROVIDER,
    baseUrl: MEEPO_MODEL_BASE_URL,
    apiKey: MEEPO_MODEL_API_KEY,
    model: MEEPO_MODEL_ID,
  };
}
