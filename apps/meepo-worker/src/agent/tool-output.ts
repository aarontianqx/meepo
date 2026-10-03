import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedText, TOOL_PAYLOAD_BYTES } from '@meepo/protocol';
import type { AnyAgentTool } from './tools.js';

/** Keep large results local, with a bounded preview for both the model and the journal. */
export function boundedTools(tools: AnyAgentTool[], dir: string): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      let result: Awaited<ReturnType<AnyAgentTool['execute']>>;
      try {
        result = await tool.execute(
          id,
          params,
          signal,
          onUpdate
            ? (update) => {
                const text = JSON.stringify(update);
                onUpdate(
                  Buffer.byteLength(text) <= TOOL_PAYLOAD_BYTES
                    ? update
                    : {
                        content: [{ type: 'text', text: boundedText(text, 8000) }],
                        details: undefined,
                      }
                );
              }
            : undefined
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (Buffer.byteLength(message) <= TOOL_PAYLOAD_BYTES) throw error;
        const path = await saveOutput(dir, JSON.stringify({ error: message }));
        throw new Error(`${boundedText(message, 8000)}\n完整错误仅保存在 worker: ${path}`, {
          cause: error,
        });
      }
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json) <= TOOL_PAYLOAD_BYTES) return result;
      const path = await saveOutput(dir, json);
      return {
        content: [
          { type: 'text', text: `${boundedText(json, 8000)}\n完整输出仅保存在 worker: ${path}` },
        ],
        details: undefined,
      };
    },
  }));
}

async function saveOutput(dir: string, json: string): Promise<string> {
  const outputDir = join(dir, '.tool-output');
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `${randomUUID()}.json`);
  await writeFile(path, json, { mode: 0o600 });
  return path;
}
