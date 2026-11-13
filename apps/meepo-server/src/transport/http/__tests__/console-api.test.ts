import { formatQuotedMessage } from '@meepo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap, type ServerRuntime } from '../../../bootstrap.js';
import { loadConfig } from '../../../config.js';

describe('console-facing HTTP surface', () => {
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
      payload: { name: 'Console space' },
    });
    spaceId = response.json<{ id: string }>().id;
  });

  afterEach(async () => {
    await runtime.app.close();
  });

  const listSessions = async (): Promise<
    Array<{ id: string; title?: string; chatLabel?: string; author?: string }>
  > =>
    (
      await runtime.app.inject({
        url: `/api/sessions?spaceId=${spaceId}`,
        headers: headers('owner'),
      })
    ).json();

  describe('GET /api/me', () => {
    it('reports the caller and whether they are a global admin', async () => {
      const admin = await runtime.app.inject({ url: '/api/me', headers: headers('admin') });
      expect(admin.json()).toEqual({ userId: 'admin', displayName: 'admin', isAdmin: true });
      const member = await runtime.app.inject({ url: '/api/me', headers: headers('owner') });
      expect(member.json()).toMatchObject({ userId: 'owner', isAdmin: false });
    });
  });

  describe('PATCH /api/spaces/:id', () => {
    const rename = (user: string, name: unknown) =>
      runtime.app.inject({
        method: 'PATCH',
        url: `/api/spaces/${spaceId}`,
        headers: headers(user),
        payload: { name },
      });

    it('renames the space and trims the name', async () => {
      const response = await rename('owner', '  Renamed  ');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: spaceId, name: 'Renamed' });
    });

    it('rejects blank names and non-members', async () => {
      expect((await rename('owner', '   ')).statusCode).toBe(400);
      expect((await rename('owner', 7)).statusCode).toBe(400);
      expect((await rename('outsider', 'Hijack')).statusCode).toBe(401);
    });
  });

  describe('GET /api/schedules', () => {
    it('returns nextFireAt for active schedules and null once cancelled', async () => {
      const at = Date.now() + 3_600_000;
      const created = await runtime.app.inject({
        method: 'POST',
        url: '/api/schedules',
        headers: headers('owner'),
        payload: {
          spaceId,
          timing: { kind: 'at', at },
          action: { kind: 'create_ticket', objective: 'audit' },
        },
      });
      expect(created.statusCode).toBe(200);
      const id = created.json<{ id: string }>().id;

      const list = () =>
        runtime.app
          .inject({ url: `/api/schedules?spaceId=${spaceId}`, headers: headers('owner') })
          .then((r) => r.json<Array<{ id: string; nextFireAt: number | null }>>());
      expect((await list()).find((s) => s.id === id)?.nextFireAt).toBe(at);

      await runtime.app.inject({
        method: 'POST',
        url: `/api/schedules/${id}/cancel`,
        headers: headers('owner'),
      });
      expect((await list()).find((s) => s.id === id)?.nextFireAt).toBeNull();
    });
  });

  describe('GET /api/sessions', () => {
    it('labels each session with its opening message, chat and author', async () => {
      const session = await runtime.services.sessionService.getOrCreateByThread({
        spaceId,
        chatId: 'oc_group',
        threadId: 'main',
        kind: 'main',
      });
      const blank = await runtime.services.sessionService.getOrCreateByThread({
        spaceId,
        chatId: 'oc_other',
        threadId: 'main',
        kind: 'main',
      });
      await runtime.services.transcriptService.appendEvent(session.id, 'user_message', {
        role: 'user',
        content: `Please\nsummarize   ${'x'.repeat(200)}`,
        timestamp: Date.now(),
        author: 'Mia',
        chatLabel: 'Growth group',
      });

      const response = await runtime.app.inject({
        url: `/api/sessions?spaceId=${spaceId}`,
        headers: headers('owner'),
      });
      const items =
        response.json<Array<{ id: string; title?: string; chatLabel?: string; author?: string }>>();
      const labelled = items.find((s) => s.id === session.id);
      expect(labelled?.title?.startsWith('Please summarize xxx')).toBe(true);
      expect(labelled?.title?.length).toBeLessThanOrEqual(120);
      expect(labelled?.title?.endsWith('…')).toBe(true);
      expect(labelled).toMatchObject({ chatLabel: 'Growth group', author: 'Mia' });
      expect(items.find((s) => s.id === blank.id)?.title).toBeUndefined();
    });

    it('titles a quote-reply by the user text, not the quoted markup', async () => {
      const session = await runtime.services.sessionService.getOrCreateByThread({
        spaceId,
        chatId: 'oc_group',
        threadId: 'quote',
        kind: 'main',
      });
      await runtime.services.transcriptService.appendEvent(session.id, 'user_message', {
        role: 'user',
        content: formatQuotedMessage({ sender: 'ou_1', body: 'old report' }, 'redo this please'),
        timestamp: Date.now(),
      });
      const items = await listSessions();
      expect(items.find((s) => s.id === session.id)?.title).toBe('redo this please');
    });

    it('falls back to an imported thread message when no turn has been recorded', async () => {
      const session = await runtime.services.sessionService.getOrCreateByThread({
        spaceId,
        chatId: 'oc_group',
        threadId: 'seeded',
        kind: 'thread',
      });
      await runtime.services.transcriptService.appendMessage(session.id, {
        role: 'assistant',
        content: 'bot greeting',
        timestamp: 1,
      });
      await runtime.services.transcriptService.appendMessage(session.id, {
        role: 'user',
        content: 'thread starter',
        timestamp: 2,
        author: 'Lee',
      });
      const items = await listSessions();
      expect(items.find((s) => s.id === session.id)).toMatchObject({
        title: 'thread starter',
        author: 'Lee',
      });
    });
  });
});
