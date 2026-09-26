import type { ModelConfig } from '@meepo/protocol';

/** One globally available model: credentials plus the wire-protocol discriminator. */
export interface ModelEntry {
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Registry of globally available models, resolved from server config. */
export interface ModelRegistry {
  entries: ModelEntry[];
  defaultModelId?: string;
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
  /** Globally available models (spaces reference these by id) */
  models: ModelRegistry;
  /** Directory of the built console SPA; static hosting is skipped when absent */
  consoleDistPath?: string;
  feishu?: FeishuConfig;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  defaultSpaceId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MEEPO_HOST ?? '0.0.0.0',
    port: Number(env.MEEPO_PORT ?? 8780),
    heartbeatIntervalSeconds: Number(env.MEEPO_HEARTBEAT_INTERVAL_SECONDS ?? 15),
    workerOfflineAfterMs: Number(env.MEEPO_WORKER_OFFLINE_AFTER_MS ?? 45_000),
    dbPath: env.MEEPO_DB_PATH ?? defaultDbPath(),
    models: loadModelRegistry(env),
    consoleDistPath: env.MEEPO_CONSOLE_DIST,
    feishu: loadFeishuConfig(env),
  };
}

function loadModelRegistry(env: NodeJS.ProcessEnv): ModelRegistry {
  if (env.MEEPO_MODELS) {
    try {
      const entries = JSON.parse(env.MEEPO_MODELS) as ModelEntry[];
      if (
        Array.isArray(entries) &&
        entries.every((e) => e.id && e.provider && e.baseUrl && e.apiKey && e.model)
      ) {
        return { entries, defaultModelId: env.MEEPO_DEFAULT_MODEL_ID ?? entries[0]?.id };
      }
    } catch {
      // fall through to legacy single-model env
    }
  }
  const legacy = loadLegacyModel(env);
  return {
    entries: legacy ? [legacy] : [],
    defaultModelId: legacy?.id,
  };
}

/** Legacy single-model env (MEEPO_MODEL_PROVIDER/BASE_URL/API_KEY/ID), kept for compatibility. */
function loadLegacyModel(env: NodeJS.ProcessEnv): ModelEntry | undefined {
  const { MEEPO_MODEL_PROVIDER, MEEPO_MODEL_BASE_URL, MEEPO_MODEL_API_KEY, MEEPO_MODEL_ID } = env;
  if (!MEEPO_MODEL_PROVIDER || !MEEPO_MODEL_BASE_URL || !MEEPO_MODEL_API_KEY || !MEEPO_MODEL_ID) {
    return undefined;
  }
  return {
    id: MEEPO_MODEL_ID,
    provider: MEEPO_MODEL_PROVIDER,
    baseUrl: MEEPO_MODEL_BASE_URL,
    apiKey: MEEPO_MODEL_API_KEY,
    model: MEEPO_MODEL_ID,
  };
}

function loadFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | undefined {
  const appId = env.MEEPO_FEISHU_APP_ID;
  const appSecret = env.MEEPO_FEISHU_APP_SECRET;
  if (!appId || !appSecret) return undefined;
  return { appId, appSecret, defaultSpaceId: env.MEEPO_DEFAULT_SPACE_ID };
}

/** Default database location: absolute, outside any project checkout. */
function defaultDbPath(): string {
  const home = process.env.HOME ?? '.';
  return `${home}/.meepo/server/meepo.db`;
}

/** Resolves a registry entry to a full ModelConfig (with optional effort override). */
export function resolveModel(
  registry: ModelRegistry,
  modelId: string,
  thinkingLevel?: ModelConfig['thinkingLevel']
): ModelConfig | undefined {
  const entry = registry.entries.find((e) => e.id === modelId);
  if (!entry) return undefined;
  return {
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    thinkingLevel,
  };
}
