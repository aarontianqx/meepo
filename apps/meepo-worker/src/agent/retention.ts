import { readdir, stat, rm, utimes, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const WEEK = 7 * 24 * 3600000;
/** Only direct task directories are reclaimed; never follow symlinks. */
export async function reclaimDirectories(
  root: string,
  protectedIds: Set<string>,
  now = Date.now()
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || protectedIds.has(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs > WEEK) await rm(path, { recursive: true, force: true });
  }
}
export async function touchDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const now = new Date();
  await utimes(path, now, now);
}
