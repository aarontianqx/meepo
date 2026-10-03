import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ImageReference } from '@meepo/protocol';
export interface MediaSource {
  namespace: string;
  download(ref: ImageReference): Promise<Buffer>;
}
const MAX_BYTES = 10 * 1024 * 1024;
/** Original bytes remain local; only a resized copy crosses the model boundary. */
export async function loadImages(
  refs: ImageReference[],
  dir: string,
  source?: MediaSource,
  imageInput = true,
  mediaDir = join(dir, '.media')
): Promise<{ images: ImageContent[]; notes: string[] }> {
  const images: ImageContent[] = [],
    notes: string[] = [];
  for (const ref of refs) {
    try {
      if (!imageInput) {
        notes.push('[图片：当前模型不支持图像输入]');
        continue;
      }
      if (ref.sizeBytes && ref.sizeBytes > MAX_BYTES) throw new Error('image exceeds 10 MB');
      await mkdir(mediaDir, { recursive: true });
      const id = createHash('sha256')
        .update(`${source?.namespace}:${ref.messageId}:${ref.fileKey}`)
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
        if (!source) throw new Error('image proxy unavailable', { cause: error });
        bytes = await source.download(ref);
        if (bytes.length > MAX_BYTES) throw new Error('image exceeds 10 MB', { cause: error });
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
