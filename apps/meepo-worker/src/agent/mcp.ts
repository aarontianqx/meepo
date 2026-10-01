import { toolContext } from './tool-context.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AnyAgentTool } from './tools.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
}
export type McpConfig = Record<string, McpServerConfig>;
interface Generation {
  references: number;
  signature: string;
  clients: Client[];
  tools: AnyAgentTool[];
}
/** Keep old generations alive for warm sessions; publication is all-or-nothing. */
export class McpManager {
  private current?: Generation;
  private readonly generations: Generation[] = [];
  async reload(config: McpConfig): Promise<void> {
    const signature = JSON.stringify(config);
    if (signature === this.current?.signature) return;
    const generation: Generation = { signature, clients: [], tools: [], references: 0 };
    try {
      for (const [server, c] of Object.entries(config)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(server) || !!c.command === !!c.url)
          throw new Error(`Invalid MCP server configuration: ${server}`);
        const client = new Client({ name: 'meepo-worker', version: '2.0.0' });
        generation.clients.push(client);
        const transport = c.command
          ? new StdioClientTransport({
              command: c.command,
              args: c.args,
              env: { ...(process.env as Record<string, string>), ...c.env },
              stderr: 'inherit',
            })
          : new StreamableHTTPClientTransport(new URL(c.url!), {
              requestInit: { headers: c.headers },
            });
        await client.connect(transport, { timeout: (c.timeoutSeconds ?? 30) * 1000 });
        let cursor: string | undefined;
        do {
          const response = await client.listTools({ cursor });
          cursor = response.nextCursor;
          for (const tool of response.tools) {
            generation.tools.push({
              name: `mcp__${server}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
              label: `${server}: ${tool.name}`,
              description: tool.description ?? tool.name,
              parameters: tool.inputSchema,
              execute: async (_id: string, args: unknown, signal?: AbortSignal) => {
                const result = await client.callTool(
                  {
                    name: tool.name,
                    arguments: args as Record<string, unknown>,
                    _meta: toolContext.getStore()
                      ? { meepoIdempotencyKey: toolContext.getStore()!.idempotencyKey }
                      : undefined,
                  },
                  undefined,
                  { signal, timeout: (c.timeoutSeconds ?? 60) * 1000 }
                );
                if (result.isError)
                  throw new Error(JSON.stringify(result.content ?? result.structuredContent));
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(result.content ?? result.structuredContent ?? result),
                    },
                  ],
                  details: undefined,
                };
              },
            });
          }
        } while (cursor);
      }
      const names = generation.tools.map((t) => t.name);
      if (new Set(names).size !== names.length)
        throw new Error('MCP tool names collide after normalization');
      this.generations.push(generation);
      this.current = generation;
      await this.collect();
    } catch (error) {
      await Promise.allSettled(generation.clients.map((c) => c.close()));
      throw error;
    }
  }
  acquire(): { tools: AnyAgentTool[]; release: () => void } {
    const generation = this.current;
    if (generation) generation.references++;
    let released = false;
    return {
      tools: generation?.tools ?? [],
      release: () => {
        if (released || !generation) return;
        released = true;
        generation.references--;
        void this.collect();
      },
    };
  }
  /** Legacy lease lasting until close; production callers release explicit leases. */
  tools(): AnyAgentTool[] {
    return this.acquire().tools;
  }
  private async collect(): Promise<void> {
    for (let i = this.generations.length - 1; i >= 0; i--) {
      const g = this.generations[i];
      if (g !== this.current && g.references === 0) {
        this.generations.splice(i, 1);
        await Promise.allSettled(g.clients.map((c) => c.close()));
      }
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.generations.flatMap((g) => g.clients.map((c) => c.close())));
    this.generations.length = 0;
    this.current = undefined;
  }
}
