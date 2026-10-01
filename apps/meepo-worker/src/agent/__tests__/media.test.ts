import { reclaimDirectories } from '../retention.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadImages } from '../media.js';

describe('image boundaries', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  });
  it('decodes an actual image, limits model dimensions, and reuses cached original bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meepo-media-'));
    dirs.push(dir);
    const source = await sharp({
      create: { width: 2200, height: 1200, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'test-token' })))
      .mockResolvedValueOnce(new Response(source));
    vi.stubGlobal('fetch', fetcher);
    const refs = [{ messageId: 'm', fileKey: 'img' }],
      credentials = { appId: 'test', appSecret: 'test' };
    const first = await loadImages(refs, dir, credentials);
    expect(first.images).toHaveLength(1);
    const metadata = await sharp(Buffer.from(first.images[0].data, 'base64')).metadata();
    expect(metadata.width).toBe(2048);
    expect((await loadImages(refs, dir, credentials)).images).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains shared media when session directories are closed or reclaimed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meepo-media-retention-'));
    dirs.push(root);
    const session = join(root, 'session');
    await mkdir(session);
    const cache = join(root, '.media');
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'test' })))
      .mockResolvedValueOnce(new Response(source));
    vi.stubGlobal('fetch', fetcher);
    const refs = [{ messageId: 'm', fileKey: 'img' }],
      credentials = { appId: 'test', appSecret: 'test' };
    expect((await loadImages(refs, session, credentials, true, cache)).images).toHaveLength(1);
    await rm(session, { recursive: true, force: true });
    await reclaimDirectories(root, new Set(['.media']), Date.now() + 8 * 86400000);
    expect((await loadImages(refs, session, credentials, true, cache)).images).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('unsupported, oversize, and failed downloads return placeholders without exposing credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meepo-media-'));
    dirs.push(dir);
    const ref = { messageId: 'm', fileKey: 'img' };
    const fetcher = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetcher);
    expect((await loadImages([ref], dir, undefined, false)).notes[0]).toBe(
      '[图片：当前模型不支持图像输入]'
    );
    expect((await loadImages([{ ...ref, sizeBytes: 11 * 1024 * 1024 }], dir)).notes[0]).toBe(
      '[图片下载失败]'
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect((await loadImages([ref], dir)).notes[0]).toBe('[图片下载失败]');
    expect(warning).toHaveBeenCalledWith('Image unavailable:', 'channel credentials unavailable');
  });
});
