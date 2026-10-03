import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuMediaDownloader } from '../media-downloader.js';
import type { ChannelService } from '../../../domain/channels/channel-service.js';
describe('server media proxy', () => {
  afterEach(() => vi.unstubAllGlobals());
  const downloader = () =>
    new FeishuMediaDownloader({
      get: () => ({ appId: 'app', appSecret: 'secret' }),
    } as unknown as ChannelService);
  it('returns bytes and metadata, never channel credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'token' })))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await downloader().download('ch', 'msg', 'key');
    expect(result).toEqual({ data: 'AQID', sizeBytes: 3, mimeType: 'image/png' });
    expect(JSON.stringify(result)).not.toMatch(/secret|token/);
  });
  it.each([true, false])('bounds image bytes with content-length present=%s', async (hasLength) => {
    const response = new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
      headers: hasLength ? { 'content-length': String(10 * 1024 * 1024 + 1) } : {},
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'token' })))
        .mockResolvedValueOnce(response)
    );
    await expect(downloader().download('ch', 'msg', 'key')).rejects.toThrow('10 MB');
  });
  it('reuses tokens until the expiry safety margin, then refreshes', async () => {
    let now = 1000;
    let issued = 0;
    const auth = vi.fn(
      async () => new Response(JSON.stringify({ tenant_access_token: `t${++issued}`, expire: 100 }))
    );
    const used: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return auth();
        used.push((init.headers as Record<string, string>).Authorization);
        return new Response('image');
      })
    );
    const client = new FeishuMediaDownloader(
      { get: () => ({ appId: 'app', appSecret: 'secret' }) } as unknown as ChannelService,
      () => now
    );
    await client.download('ch', 'msg', 'one');
    now += 89999;
    await client.download('ch', 'msg', 'two');
    now += 1;
    await client.download('ch', 'msg', 'three');
    expect(auth).toHaveBeenCalledTimes(2);
    expect(used).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t2']);
  });
  it('coalesces concurrent authentication without sharing tokens across channels', async () => {
    const auth = vi.fn(
      async () => new Response(JSON.stringify({ tenant_access_token: 'token', expire: 7200 }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        init.method === 'POST' ? auth() : new Response('image')
      )
    );
    const client = downloader();
    await Promise.all([client.download('a', 'msg', 'one'), client.download('a', 'msg', 'two')]);
    expect(auth).toHaveBeenCalledTimes(1);
    await client.download('b', 'msg', 'three');
    expect(auth).toHaveBeenCalledTimes(2);
  });
  it('does not let an old in-flight authentication replace rotated credentials', async () => {
    let secret = 'old';
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const used: string[] = [];
    const auth = vi.fn((init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { app_secret: string };
      return body.app_secret === 'old'
        ? oldResponse
        : Promise.resolve(
            new Response(JSON.stringify({ tenant_access_token: 'new-token', expire: 7200 }))
          );
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return auth(init);
        used.push((init.headers as Record<string, string>).Authorization);
        return new Response('image');
      })
    );
    const client = new FeishuMediaDownloader({
      get: () => ({ appId: 'app', appSecret: secret }),
    } as unknown as ChannelService);
    const oldDownload = client.download('ch', 'msg', 'one');
    secret = 'new';
    await client.download('ch', 'msg', 'two');
    resolveOld(new Response(JSON.stringify({ tenant_access_token: 'old-token', expire: 7200 })));
    await oldDownload;
    await client.download('ch', 'msg', 'three');
    expect(auth).toHaveBeenCalledTimes(2);
    expect(used).toEqual(['Bearer new-token', 'Bearer old-token', 'Bearer new-token']);
  });
  it('retries authentication after a failed fetch', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tenant_access_token: 'token', expire: 7200 }))
      )
      .mockResolvedValueOnce(new Response('image'));
    vi.stubGlobal('fetch', fetcher);
    const client = downloader();
    await expect(client.download('ch', 'msg', 'one')).rejects.toThrow('network unavailable');
    await expect(client.download('ch', 'msg', 'two')).resolves.toHaveProperty('sizeBytes', 5);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('invalidates a rejected token for the next download', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tenant_access_token: 'old', expire: 7200 }))
      )
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tenant_access_token: 'new', expire: 7200 }))
      )
      .mockResolvedValueOnce(new Response('image'));
    vi.stubGlobal('fetch', fetcher);
    const client = downloader();
    await expect(client.download('ch', 'msg', 'one')).rejects.toThrow('Image download failed');
    await client.download('ch', 'msg', 'two');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[3][1].headers.Authorization).toBe('Bearer new');
  });
});
