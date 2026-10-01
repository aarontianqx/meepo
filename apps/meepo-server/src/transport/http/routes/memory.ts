import type { FastifyInstance } from 'fastify';
import type { MemoryWriteInput } from '../../../domain/memory/memory-service.js';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';
import { validation } from '../../../domain/errors.js';

export function registerMemoryRoutes(app: FastifyInstance, services: ServiceContainer): void {
  const memory = services.memoryService!;
  type Query = {
    spaceId: string;
    prefix?: string;
    limit?: string;
    offset?: string;
    tail?: string;
    q?: string;
    expected_revision?: string;
  };
  const num = (s?: string) => (s === undefined ? undefined : Number(s));
  app.get<{ Querystring: Query }>('/api/memory', async (req) =>
    memory.list(req.query.spaceId, req.query.prefix, num(req.query.limit))
  );
  app.get<{ Querystring: Query }>('/api/memory/search', async (req) =>
    memory.search(req.query.spaceId, req.query.q ?? '', req.query.prefix, num(req.query.limit))
  );
  app.get<{ Params: { '*': string }; Querystring: Query }>('/api/memory/*', async (req) =>
    memory.read(req.query.spaceId, req.params['*'], {
      offset: num(req.query.offset),
      limit: num(req.query.limit),
      tail: num(req.query.tail),
    })
  );
  app.put<{ Params: { '*': string }; Querystring: Query }>('/api/memory/*', async (req) => {
    if (!req.body || typeof req.body !== 'object') throw validation('Memory body is required');
    return memory.write(
      req.query.spaceId,
      { ...(req.body as MemoryWriteInput), path: req.params['*'] },
      { kind: 'console', userId: identityOf(req).userId }
    );
  });
  app.delete<{ Params: { '*': string }; Querystring: Query }>('/api/memory/*', async (req) =>
    memory.delete(req.query.spaceId, req.params['*'], Number(req.query.expected_revision))
  );
}
