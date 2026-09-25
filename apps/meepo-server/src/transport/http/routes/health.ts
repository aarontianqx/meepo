import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: Date.now(),
  }));
}
