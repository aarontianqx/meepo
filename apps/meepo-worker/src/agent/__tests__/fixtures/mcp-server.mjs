import process from 'node:process';
import { setTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize')
    reply({
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test', version: '1' },
    });
  else if (request.method === 'tools/list')
    reply({
      tools: [
        {
          name: 'echo',
          description: 'test tool',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    });
  else if (request.method === 'tools/call') {
    if (request.params.arguments?.text === 'wait')
      setTimeout(() => reply({ content: [{ type: 'text', text: 'late' }] }), 30000).unref();
    else
      reply({
        content: [
          {
            type: 'text',
            text:
              request.params.arguments?.text === 'meta'
                ? JSON.stringify(request.params._meta)
                : (request.params.arguments?.text ?? 'echo'),
          },
        ],
        meta: request.params._meta,
      });
  } else reply({});
});
