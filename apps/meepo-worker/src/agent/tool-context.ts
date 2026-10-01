import { AsyncLocalStorage } from 'node:async_hooks';
import type { AnyAgentTool } from './tools.js';
export const toolContext = new AsyncLocalStorage<{ idempotencyKey: string }>();
export function withTicketContext(tools: AnyAgentTool[], key: string): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: Parameters<AnyAgentTool['execute']>[3]
    ) => {
      let input = params;
      if (
        tool.name === 'bash' &&
        params &&
        typeof params === 'object' &&
        'command' in params &&
        typeof params.command === 'string'
      ) {
        const quoted = "'" + key.replace(/'/g, "'\\''") + "'";
        input = { ...params, command: `export MEEPO_IDEMPOTENCY_KEY=${quoted}\n${params.command}` };
      }
      return toolContext.run({ idempotencyKey: key }, () =>
        tool.execute(id, input, signal, onUpdate)
      );
    },
  }));
}
