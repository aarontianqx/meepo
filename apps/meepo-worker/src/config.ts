import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

export interface WorkerConfig {
  /** Full WebSocket URL of the server worker channel */
  serverUrl: string;
  /** Enrollment token issued by the space owner */
  enrollmentToken: string;
  /** Stable worker identity; persisted across restarts by the operator */
  workerId: string;
  tags: string[];
  maxSlots: number;
  /** Base directory for repo caches and git worktrees (tickets) */
  workspaceDir: string;
  /** Root for neutral per-session working directories */
  sessionsDir: string;
  /** Idle session runners are dropped after this many milliseconds */
  sessionTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const enrollmentToken = env.MEEPO_ENROLLMENT_TOKEN;
  if (!enrollmentToken) {
    throw new Error('MEEPO_ENROLLMENT_TOKEN is required (issue one via the server API or console)');
  }
  return {
    serverUrl: env.MEEPO_SERVER_URL ?? 'ws://127.0.0.1:8780/ws/worker',
    enrollmentToken,
    workerId: env.MEEPO_WORKER_ID ?? `worker-${hostname()}`,
    tags: (env.MEEPO_TAGS ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    maxSlots: Number(env.MEEPO_MAX_SLOTS ?? 1),
    workspaceDir: env.MEEPO_WORKSPACE_DIR ?? join(homedir(), '.meepo', 'workspaces'),
    sessionsDir: env.MEEPO_SESSIONS_DIR ?? join(homedir(), '.meepo', 'sessions'),
    sessionTtlMs: Number(env.MEEPO_SESSION_TTL_MS ?? 3_600_000),
  };
}
