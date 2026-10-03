import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServiceContainer } from '../../../service-container.js';
import { identityOf } from '../auth.js';
import { validation } from '../../../domain/errors.js';

export function registerObservationRoutes(app: FastifyInstance, services: ServiceContainer): void {
  app.get<{ Params: { id: string } }>('/api/spaces/:id/usage', async (req) => {
    const [sessions, tickets] = await Promise.all([
      services.sessionService.listBySpace(req.params.id),
      services.ticketService.listTickets(req.params.id),
    ]);
    return services.runRepository!.usage(
      sessions.map((s) => s.id),
      tickets.map((t) => t.id)
    );
  });
  app.post<{ Params: { id: string; runId: string } }>(
    '/api/sessions/:id/runs/:runId/abort',
    async (req) => {
      const run = await services.runRepository!.getById(req.params.runId);
      if (!run || run.work.kind !== 'turn' || run.work.turnRef.sessionId !== req.params.id)
        throw validation('Run is outside this session');
      return { interrupted: await services.dispatchService.abortRun(run.id) };
    }
  );
  const grants = new Map<string, { sessionId: string; userId: string; expires: number }>();
  app.post<{ Params: { id: string } }>('/api/sessions/:id/mailbox', async (req) => {
    const body = req.body as { content: string };
    if (typeof body?.content !== 'string' || !body.content.trim() || body.content.length > 32000)
      throw validation('Mailbox message must have 1–32000 characters');
    const user = identityOf(req);
    return services.dispatchService.dispatchSessionTurn({
      sessionId: req.params.id,
      prompt: `[Console message from ${user.displayName}]\n${body.content}`,
      author: user.displayName,
      authorOpenId: user.userId,
      source: { kind: 'system' },
      sourceId: randomUUID(),
      delivery: 'wait',
      eventType: 'system_note',
    });
  });
  app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
    '/api/sessions/:id/events',
    async (req) =>
      services.transcriptService.listEvents(req.params.id, Number(req.query.afterSeq ?? 0))
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id/runs', async (req) =>
    services.runRepository!.list({ sessionId: req.params.id })
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/close', async (req) =>
    services.sessionService.close(req.params.id)
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/stream-token', async (req) => {
    for (const [key, grant] of grants) if (grant.expires < Date.now()) grants.delete(key);
    const token = randomBytes(24).toString('base64url');
    grants.set(token, {
      sessionId: req.params.id,
      userId: identityOf(req).userId,
      expires: Date.now() + 30000,
    });
    return { token };
  });
  app.get<{ Params: { token: string }; Querystring: { afterSeq?: string } }>(
    '/ws/console/:token',
    { websocket: true },
    (socket, req) => {
      const grant = grants.get(req.params.token);
      grants.delete(req.params.token);
      if (!grant || grant.expires < Date.now()) {
        socket.close(1008, 'Expired stream grant');
        return;
      }
      let seq = Number(req.query.afterSeq ?? 0),
        busy = false;
      if (!Number.isSafeInteger(seq) || seq < 0) {
        socket.close(1008, 'Invalid sequence');
        return;
      }
      const send = async () => {
        if (busy || socket.readyState !== 1) return;
        busy = true;
        try {
          const session = await services.sessionService.getSession(grant.sessionId);
          await services.membershipService.requireMember(session.spaceId, grant.userId);
          const events = await services.transcriptService.listEvents(session.id, seq);
          for (const event of events) {
            socket.send(JSON.stringify(event));
            seq = event.seq;
          }
        } catch {
          socket.close(1008, 'Session access ended');
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => {
        void send();
      }, 250);
      timer.unref();
      socket.once('close', () => clearInterval(timer));
      void send();
    }
  );
  app.get<{ Params: { id: string } }>('/api/tickets/:id/runs', async (req) => {
    const runs = await services.runRepository!.listByTicket(req.params.id);
    return runs.map((run) => ({ ...run, events: services.executionJournal!.listByRun(run.id) }));
  });
  app.post<{ Params: { id: string } }>('/api/tickets/:id/cancel', async (req) => {
    const ticket = await services.ticketService.cancelTicket(req.params.id);
    await services.dispatchService.stopTicketExecutions(ticket.id);
    return ticket;
  });
  app.post<{ Params: { id: string } }>('/api/tickets/:id/abandon', async (req) =>
    services.ticketService.abandonTicket(req.params.id)
  );
}
