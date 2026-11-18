import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap, type ServerRuntime } from '../../../bootstrap.js';
import { loadConfig } from '../../../config.js';

describe('global and space instructions over HTTP', () => {
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
      payload: { name: 'Rules', instructions: '  be brief  ' },
    });
    spaceId = response.json<{ id: string }>().id;
  });
  afterEach(() => runtime.app.close());

  it('lets only global administrators read or write the global instructions', async () => {
    const put = (user: string, instructions: string) =>
      runtime.app.inject({
        method: 'PUT',
        url: '/api/settings/instructions',
        headers: headers(user),
        payload: { instructions },
      });
    expect((await put('owner', 'x')).statusCode).toBe(401);
    expect(
      (
        await runtime.app.inject({
          method: 'GET',
          url: '/api/settings/instructions',
          headers: headers('owner'),
        })
      ).statusCode
    ).toBe(401);

    expect((await put('admin', ' always cite sources ')).json()).toEqual({
      instructions: 'always cite sources',
    });
    const read = await runtime.app.inject({
      method: 'GET',
      url: '/api/settings/instructions',
      headers: headers('admin'),
    });
    expect(read.json()).toEqual({ instructions: 'always cite sources' });
    expect((await put('admin', '')).json()).toEqual({ instructions: '' });
  });

  it('rejects non-string global instructions', async () => {
    const response = await runtime.app.inject({
      method: 'PUT',
      url: '/api/settings/instructions',
      headers: headers('admin'),
      payload: { instructions: 42 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('stores space instructions trimmed, lets members edit and clear them', async () => {
    const get = async () =>
      (
        await runtime.app.inject({
          method: 'GET',
          url: `/api/spaces/${spaceId}`,
          headers: headers('owner'),
        })
      ).json<{ instructions?: string }>().instructions;
    expect(await get()).toBe('be brief');

    const patch = (user: string, instructions: unknown) =>
      runtime.app.inject({
        method: 'PATCH',
        url: `/api/spaces/${spaceId}`,
        headers: headers(user),
        payload: { instructions },
      });
    expect((await patch('owner', ' answer in Chinese ')).statusCode).toBe(200);
    expect(await get()).toBe('answer in Chinese');
    expect((await patch('outsider', 'hijack')).statusCode).toBe(401);
    expect((await patch('owner', 7)).statusCode).toBe(400);
    expect((await patch('owner', '')).statusCode).toBe(200);
    expect(await get()).toBeUndefined();
  });
});
