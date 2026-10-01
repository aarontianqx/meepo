import { parse } from 'smol-toml';
import type { McpConfig } from './agent/mcp.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorkerConfig {
  configPath?: string;
  mcp?: McpConfig;
  modelDefaults?: { thinkingLevel?: 'low' | 'high' | 'max' };
  /** Full WebSocket URL of the server worker channel */
  serverUrl: string;
  /** Enrollment token issued by the space owner */
  enrollmentToken: string;
  /** Stable worker identity; persisted across restarts by the operator */
  workerId: string;
  dataDir?: string;
  tags: string[];
  maxSlots: number;
  /** Root for neutral per-session working directories */
  sessionsDir: string;
  /** Root for neutral per-ticket working directories */
  ticketsDir: string;
  /** Idle session runners are dropped after this many milliseconds */
  sessionTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const configPath = env.MEEPO_WORKER_CONFIG ?? join(homedir(), '.meepo', 'worker.toml');
  const file = readWorkerFile(configPath);
  const mergedEnv = { ...env, MEEPO_DATA_DIR: env.MEEPO_DATA_DIR ?? file.dataDir };
  const enrollmentToken = env.MEEPO_ENROLLMENT_TOKEN ?? file.enrollmentToken;
  if (!enrollmentToken) {
    throw new Error('MEEPO_ENROLLMENT_TOKEN is required (issue one via the server API or console)');
  }
  const config: WorkerConfig = {
    configPath,
    mcp: file.mcp ?? {},
    modelDefaults: {
      thinkingLevel: (env.MEEPO_THINKING_LEVEL ?? file.modelDefaults?.thinkingLevel) as
        'low' | 'high' | 'max' | undefined,
    },
    serverUrl: env.MEEPO_SERVER_URL ?? file.serverUrl ?? 'ws://127.0.0.1:8780/ws/worker',
    enrollmentToken,
    workerId: persistentWorkerId(mergedEnv),
    dataDir: mergedEnv.MEEPO_DATA_DIR ?? join(homedir(), '.meepo', 'worker'),
    tags: (env.MEEPO_TAGS ?? file.tags?.join(',') ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    maxSlots: Number(env.MEEPO_MAX_SLOTS ?? file.maxSlots ?? 1),
    sessionsDir:
      env.MEEPO_SESSIONS_DIR ?? file.sessionsDir ?? join(homedir(), '.meepo', 'sessions'),
    ticketsDir: env.MEEPO_TICKETS_DIR ?? file.ticketsDir ?? join(homedir(), '.meepo', 'tickets'),
    sessionTtlMs: Number(env.MEEPO_SESSION_TTL_MS ?? file.sessionTtlMs ?? 3_600_000),
  };
  if (
    config.modelDefaults?.thinkingLevel &&
    !['low', 'high', 'max'].includes(config.modelDefaults.thinkingLevel)
  )
    throw new Error('Invalid default thinkingLevel');
  if (!Number.isSafeInteger(config.maxSlots) || config.maxSlots < 1 || config.maxSlots > 128)
    throw new Error('maxSlots must be 1–128');
  if (!Number.isFinite(config.sessionTtlMs) || config.sessionTtlMs < 1000)
    throw new Error('sessionTtlMs must be at least 1000');
  if (!['ws:', 'wss:'].includes(new URL(config.serverUrl).protocol))
    throw new Error('Invalid worker server URL');
  return config;
}

function persistentWorkerId(env: NodeJS.ProcessEnv): string {
  const dir = env.MEEPO_DATA_DIR ?? join(homedir(), '.meepo', 'worker');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'worker-id');
  try {
    writeFileSync(file, env.MEEPO_WORKER_ID ?? randomUUID(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const id = readFileSync(file, 'utf8').trim();
  if (env.MEEPO_WORKER_ID && env.MEEPO_WORKER_ID !== id)
    throw new Error('MEEPO_WORKER_ID conflicts with persisted worker identity');
  return id;
}

export function readWorkerFile(path: string): Partial<WorkerConfig> {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config = (
    path.endsWith('.json') ? JSON.parse(source) : parse(source)
  ) as Partial<WorkerConfig>;
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid worker config');
  if (
    config.tags &&
    (!Array.isArray(config.tags) || config.tags.some((t) => typeof t !== 'string'))
  )
    throw new Error('tags must be strings');
  if (config.mcp && (typeof config.mcp !== 'object' || Array.isArray(config.mcp)))
    throw new Error('mcp must be a server map');
  return config;
}
