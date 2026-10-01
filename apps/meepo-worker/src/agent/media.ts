import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ImageReference, MediaCredentials } from '@meepo/protocol';
const MAX_BYTES = 10 * 1024 * 1024;
/** Original bytes remain local; only a resized copy crosses the model boundary. */
export async function loadImages(
  refs: ImageReference[],
  dir: string,
  credentials?: MediaCredentials,
  imageInput = true,
  mediaDir = join(dir, '.media')
): Promise<{ images: ImageContent[]; notes: string[] }> {
  const images: ImageContent[] = [],
    notes: string[] = [];
  let token: string | undefined;
  for (const ref of refs) {
    try {
      if (!imageInput) {
        notes.push('[图片：当前模型不支持图像输入]');
        continue;
      }
      if (ref.sizeBytes && ref.sizeBytes > MAX_BYTES) throw new Error('image exceeds 10 MB');
      await mkdir(mediaDir, { recursive: true });
      const id = createHash('sha256')
        .update(`${credentials?.appId}:${ref.messageId}:${ref.fileKey}`)
        .digest('hex');
      const path = join(mediaDir, id);
      if (mediaDir !== join(dir, '.media')) {
        // Preserve originals downloaded before media was separated from task directories.
        await copyFile(join(dir, '.media', id), path, constants.COPYFILE_EXCL).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
          }
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!credentials) throw new Error('channel credentials unavailable', { cause: error });
        if (!token) {
          const response = await fetch(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                app_id: credentials.appId,
                app_secret: credentials.appSecret,
              }),
              signal: AbortSignal.timeout(15000),
            }
          );
          const data = (await response.json()) as { tenant_access_token?: string };
          if (!response.ok || !data.tenant_access_token)
            throw new Error('channel authentication failed', { cause: error });
          token = data.tenant_access_token;
        }
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(ref.messageId)}/resources/${encodeURIComponent(ref.fileKey)}?type=image`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }
        );
        if (!response.ok || !response.body)
          throw new Error(`image download failed (${response.status})`, { cause: error });
        if (Number(response.headers.get('content-length')) > MAX_BYTES) {
          await response.body.cancel();
          throw new Error('image exceeds 10 MB', { cause: error });
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES) {
              await reader.cancel();
              throw new Error('image exceeds 10 MB', { cause: error });
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        bytes = Buffer.concat(chunks);
        await writeFile(path, bytes, { mode: 0o600 });
      }
      if (bytes.length > MAX_BYTES) throw new Error('image exceeds 10 MB');
      const resized = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      images.push({ type: 'image', data: resized.toString('base64'), mimeType: 'image/jpeg' });
      notes.push(`[Image original: ${path}]`);
    } catch (error) {
      console.warn(
        'Image unavailable:',
        error instanceof Error ? error.message : 'download failed'
      );
      notes.push('[图片下载失败]');
    }
  }
  return { images, notes };
}
