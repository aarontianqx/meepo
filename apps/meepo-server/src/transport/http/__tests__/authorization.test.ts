import { WorkerConnectionHub } from '../../ws/worker-connection-hub.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, type ServerRuntime } from '../../../bootstrap.js';
import { loadConfig } from '../../../config.js';

describe('HTTP v2 ownership boundaries', () => {
  let runtime: ServerRuntime;
  let spaceId: string;
  const headers = (user: string) => ({ 'x-meepo-user-id': user });
  beforeEach(async () => {
    runtime = await bootstrap({
      ...loadConfig({}),
      dbPath: ':memory:',
      consoleDistPath: '/nonexistent',
      adminUserIds: ['admin'],
      secretKey: '0'.repeat(64),
    });
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: headers('owner'),
      payload: { name: 'Private' },
    });
    expect(response.statusCode).toBe(200);
    spaceId = response.json<{ id: string }>().id;
  });
  afterEach(async () => {
    await runtime.app.close();
    vi.restoreAllMocks();
  });
  it.each(['claimed', 'running'] as const)(
    'cancels a %s ticket, fences its run, and sends abort through the production transport',
    async (status) => {
      const ticket = await runtime.services.ticketService.createTicket({
        spaceId,
        title: 'cancel',
        objective: 'cancel',
      });
      expect(ticket.pendingSince).toBe(ticket.createdAt);
      await runtime.services.ticketService.claimTicket(ticket.id, 'worker');
      if (status === 'running')
        await runtime.services.ticketService.markRunning(ticket.id, 'worker');
      await runtime.services.runRepository!.save({
        id: 'cancel-run',
        work: { kind: 'ticket', ticketId: ticket.id },
        attempt: 1,
        status: status === 'running' ? 'running' : 'dispatched',
        workerId: 'worker',
        createdAt: Date.now(),
      });
      const send = vi.spyOn(WorkerConnectionHub.prototype, 'sendToWorker');
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: `/api/tickets/${ticket.id}/cancel`,
            headers: headers('outsider'),
          })
        ).statusCode
      ).toBe(401);
      expect(send).not.toHaveBeenCalled();
      expect((await runtime.services.ticketService.getTicket(ticket.id)).status).toBe(status);
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/cancel`,
        headers: headers('owner'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'cancelled' });
      expect(await runtime.services.runRepository!.getById('cancel-run')).toMatchObject({
        status: 'failed',
        terminalReason: 'cancelled',
      });
      expect(send).toHaveBeenCalledExactlyOnceWith('worker', {
        kind: 'notification',
        event: 'run.abort',
        payload: { runId: 'cancel-run' },
      });
      expect(
        runtime.services.executionJournal!.TxAppend(
          'worker',
          {
            type: 'run_started',
            runId: 'cancel-run',
            workerId: 'worker',
            clientSeq: 1,
          },
          Date.now()
        ).reason
      ).toBe('run_terminal');
      const repeated = await runtime.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/cancel`,
        headers: headers('owner'),
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toEqual(response.json());
      expect(send).toHaveBeenCalledTimes(2);
    }
  );

  it('HTTP turns accept only wait delivery, without dispatching reserved modes', async () => {
    const session = await runtime.services.sessionService.getOrCreateByThread({
      spaceId,
      chatId: 'console',
      threadId: 'delivery',
      kind: 'main',
    });
    const dispatch = vi
      .spyOn(runtime.services.dispatchService, 'dispatchSessionTurn')
      .mockResolvedValue({ dispatched: false, queued: true });
    for (const delivery of ['urgent', 'if_idle', 'invalid', null]) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/turns`,
        headers: headers('owner'),
        payload: { prompt: 'hello', delivery },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(dispatch).not.toHaveBeenCalled();
    for (const delivery of [undefined, 'wait']) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/turns`,
        headers: headers('owner'),
        payload: { prompt: 'hello', delivery },
      });
      expect(response.statusCode).toBe(200);
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          delivery: 'wait',
          authorOpenId: 'owner',
          source: expect.objectContaining({ kind: 'user_message' }),
        })
      );
    }
  });

  it('global admin manages registries but cannot read private space resources', async () => {
    expect(
      (await runtime.app.inject({ url: '/api/models', headers: headers('owner') })).statusCode
    ).toBe(401);
    expect(
      (await runtime.app.inject({ url: '/api/models', headers: headers('admin') })).statusCode
    ).toBe(200);
    expect(
      (await runtime.app.inject({ url: `/api/spaces/${spaceId}`, headers: headers('admin') }))
        .statusCode
    ).toBe(401);
    expect(
      (await runtime.app.inject({ url: '/api/spaces', headers: headers('admin') })).json()
    ).toEqual([]);
  });
  it('aggregates only the requested space usage and requires membership', async () => {
    const session = await runtime.services.sessionService.getOrCreateByThread({
      spaceId,
      chatId: 'usage',
      threadId: 'user',
      kind: 'main',
    });
    const ticket = await runtime.services.ticketService.createTicket({
      spaceId,
      title: 'usage',
      objective: 'usage',
    });
    for (const run of [
      {
        id: 'turn',
        work: { kind: 'turn' as const, turnRef: { sessionId: session.id, sourceId: 'm' } },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        id: 'ticket',
        work: { kind: 'ticket' as const, ticketId: ticket.id },
        usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.1 },
      },
      {
        id: 'other',
        work: { kind: 'turn' as const, turnRef: { sessionId: 'foreign', sourceId: 'm' } },
        usage: { inputTokens: 999, outputTokens: 999 },
      },
    ])
      await runtime.services.runRepository!.save({
        ...run,
        attempt: 1,
        status: 'completed',
        createdAt: 1,
      });
    const url = `/api/spaces/${spaceId}/usage`;
    expect((await runtime.app.inject({ url, headers: headers('owner') })).json()).toEqual({
      runCount: 2,
      reportedRunCount: 2,
      inputTokens: 30,
      outputTokens: 12,
      costUsd: 0.1,
      costReportedRunCount: 1,
    });
    expect((await runtime.app.inject({ url, headers: headers('outsider') })).statusCode).toBe(401);
  });

  it('binds groups through channels and rejects obsolete channel-less binding routes', async () => {
    const channel = await runtime.services.channelService!.save({
      name: 'test',
      type: 'feishu',
      appId: 'test-app',
      appSecret: 'test-secret',
      spaceId,
      allowedOpenIds: [],
      boundChatIds: [],
    });
    expect(
      (
        await runtime.app.inject({
          method: 'PUT',
          url: `/api/spaces/${spaceId}/channels/${channel.id}/chats`,
          headers: headers('owner'),
          payload: { chatIds: ['chat-new'] },
        })
      ).statusCode
    ).toBe(200);
    expect(runtime.services.channelService!.get(channel.id).boundChatIds).toEqual(['chat-new']);
    expect(
      (
        await runtime.app.inject({ url: `/api/spaces/${spaceId}`, headers: headers('owner') })
      ).json().boundChatIds
    ).toEqual(['chat-new']);
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: `/api/spaces/${spaceId}/chats`,
          headers: headers('owner'),
          payload: { chatId: 'ignored' },
        })
      ).statusCode
    ).toBe(404);
  });

  it('returns validation errors for missing bodies and malformed administration fields', async () => {
    for (const [method, url, payload, user] of [
      ['POST', '/api/spaces', undefined, 'owner'],
      ['POST', '/api/enrollments', {}, 'owner'],
      ['POST', `/api/spaces/${spaceId}/members`, {}, 'owner'],
      ['POST', `/api/spaces/${spaceId}/binding`, {}, 'owner'],
      [
        'PUT',
        `/api/spaces/${spaceId}/model`,
        { model: { modelId: 'm', thinkingLevel: 'invalid' } },
        'owner',
      ],
      ['PUT', '/api/models', { id: [] }, 'admin'],
    ] as const) {
      expect(
        (await runtime.app.inject({ method, url, payload, headers: headers(user) })).statusCode
      ).toBe(400);
    }
  });

  it('webhook ignores forged ownership fields and requires membership', async () => {
    const url = `/api/webhooks/${spaceId}/tickets`;
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url,
          headers: headers('outsider'),
          payload: { objective: 'test', userId: 'owner' },
        })
      ).statusCode
    ).toBe(401);
    const allowed = await runtime.app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: { objective: 'test', originSessionId: 'forged' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ originSessionId?: string }>().originSessionId).toBeUndefined();
    expect(
      (await runtime.app.inject({ method: 'POST', url, headers: headers('owner'), payload: {} }))
        .statusCode
    ).toBe(400);
    expect(
      (await runtime.app.inject({ url: '/api/tickets', headers: headers('outsider') })).json()
    ).toEqual([]);
    expect(
      (
        await runtime.app.inject({
          url: `/api/tickets/${allowed.json<{ id: string }>().id}`,
          headers: headers('outsider'),
        })
      ).statusCode
    ).toBe(401);
  });
  it('session transcript, mailbox, close, and stream grant all require membership', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers('owner'),
      payload: { spaceId },
    });
    const id = response.json<{ id: string }>().id;
    expect(id).toBeTruthy();
    for (const [method, suffix, payload] of [
      ['GET', 'snapshot', undefined],
      ['GET', 'events', undefined],
      ['POST', 'mailbox', { content: 'injected' }],
      ['POST', 'close', undefined],
      ['POST', 'stream-token', undefined],
    ] as const) {
      expect(
        (
          await runtime.app.inject({
            method,
            url: `/api/sessions/${id}/${suffix}`,
            headers: headers('outsider'),
            payload,
          })
        ).statusCode
      ).toBe(401);
    }
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: headers('owner'),
          payload: { spaceId, channelId: 'forged', anchorMessageId: 'victim' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: `/api/sessions/${id}/stream-token`,
          headers: headers('owner'),
        })
      ).statusCode
    ).toBe(200);
  });
  it('operators cannot delete a space or remove its owner', async () => {
    await runtime.app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      headers: headers('owner'),
      payload: { userId: 'operator' },
    });
    expect(
      (
        await runtime.app.inject({
          method: 'DELETE',
          url: `/api/spaces/${spaceId}`,
          headers: headers('operator'),
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await runtime.app.inject({
          method: 'DELETE',
          url: `/api/spaces/${spaceId}/members/owner`,
          headers: headers('operator'),
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await runtime.app.inject({
          method: 'DELETE',
          url: `/api/spaces/${spaceId}`,
          headers: headers('owner'),
        })
      ).statusCode
    ).toBe(200);
  });
  it('production composition wires transactional session reset', async () => {
    const old = await runtime.services.sessionService.getOrCreateByThread({
      spaceId,
      chatId: 'chat',
      threadId: 'user',
      kind: 'main',
      channelId: 'ch',
      anchorMessageId: 'original',
    });
    const fresh = await runtime.services.sessionService.reset(old.id, 'new-command', {
      channelId: 'ch',
      messageId: 'new-command',
    });
    expect(fresh?.id).not.toBe(old.id);
    expect(fresh).toBeDefined();
    expect((await runtime.services.sessionService.getSession(old.id)).status).toBe('closed');
    const next = await runtime.services.sessionService.reset(fresh!.id, 'new-command', {
      channelId: 'ch',
      messageId: 'new-command',
    });
    expect(next?.id).toBe(fresh?.id);
  });

  it('webhook tokens cannot access other spaces or console APIs and rotation invalidates old credentials', async () => {
    const first = await runtime.app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/webhook-token`,
      headers: headers('owner'),
    });
    const token = first.json<{ token: string }>().token;
    const request = {
      method: 'POST' as const,
      url: `/api/webhooks/${spaceId}/tickets`,
      headers: { authorization: `Bearer ${token}` },
      payload: { objective: 'test' },
    };
    expect((await runtime.app.inject(request)).statusCode).toBe(200);
    expect(
      (await runtime.app.inject({ ...request, url: '/api/webhooks/other/tickets' })).statusCode
    ).toBe(401);
    expect(
      (await runtime.app.inject({ url: `/api/spaces/${spaceId}`, headers: request.headers }))
        .statusCode
    ).toBe(401);
    await runtime.app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/webhook-token`,
      headers: headers('owner'),
    });
    expect((await runtime.app.inject(request)).statusCode).toBe(401);
  });
});
