// Keeps worker-owned credentials out of the subprocesses an agent can run.
import type { ToolsOptions } from '@earendil-works/pi-coding-agent';

const WORKER_VARIABLE_PREFIX = 'MEEPO_';

/** Copy of `env` without the worker's own `MEEPO_*` variables (enrollment token, server URL, data paths). */
export function withoutWorkerVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith(WORKER_VARIABLE_PREFIX))
  );
}

/** Options for the built-in coding tools: bash never inherits the worker's credentials. */
export const codingToolOptions: ToolsOptions = {
  bash: { spawnHook: (context) => ({ ...context, env: withoutWorkerVariables(context.env) }) },
};
