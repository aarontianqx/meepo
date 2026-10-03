import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTicketContext } from '../tool-context.js';
import { McpManager } from '../mcp.js';

describe('worker MCP tool generations', () => {
  it('connects stdio, namespaces tools, propagates abort and retains old tools after failed reload', async () => {
    const manager = new McpManager();
    try {
      await manager.reload({
        local: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
        },
      });
      const old = manager.tools();
      expect(old.map((t) => t.name)).toEqual(['mcp__local__echo']);
      expect(await old[0].execute('call', { text: 'hello' })).toMatchObject({
        content: [{ text: expect.stringContaining('hello') }],
      });
      await expect(manager.reload({ broken: { url: 'not-a-url' } })).rejects.toThrow();
      expect(manager.tools()).toBe(old);
      expect(
        await withTicketContext(old, 'ticket-1-2')[0].execute('meta', { text: 'meta' })
      ).toMatchObject({ content: [{ text: expect.stringContaining('meepoIdempotencyKey') }] });
      expect(
        await withTicketContext(old, 'ticket-1-2')[0].execute('meta', { text: 'meta' })
      ).toMatchObject({ content: [{ text: expect.stringContaining('ticket-1-2') }] });
      const abort = new AbortController();
      const pending = old[0].execute('wait', { text: 'wait' }, abort.signal);
      abort.abort();
      await expect(pending).rejects.toThrow();
      await manager.reload({});
      expect(manager.tools()).toEqual([]);
      expect(await old[0].execute('still-warm', { text: 'warm session' })).toMatchObject({
        content: [{ text: expect.stringContaining('warm session') }],
      });
    } finally {
      await manager.close();
    }
  });
  it('connects a remote Streamable HTTP MCP endpoint', async () => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const frame = JSON.parse(body) as {
        id?: number;
        method: string;
        params: { protocolVersion: string };
      };
      if (frame.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        frame.method === 'initialize'
          ? {
              protocolVersion: frame.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'remote', version: '1' },
            }
          : frame.method === 'tools/list'
            ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'pong' }] };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const manager = new McpManager();
    try {
      await manager.reload({ remote: { url: `http://127.0.0.1:${address.port}/mcp` } });
      expect(await manager.tools()[0].execute('ping', {})).toMatchObject({
        content: [{ text: expect.stringContaining('pong') }],
      });
    } finally {
      await manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
