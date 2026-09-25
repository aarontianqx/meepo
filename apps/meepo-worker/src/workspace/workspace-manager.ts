import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceSpec } from '@meepo/protocol';

const execFileAsync = promisify(execFile);

export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

type GitRunner = (args: string[]) => Promise<unknown>;

/**
 * Layout under `baseDir`:
 *
 *   <sha1(repoUrl)>/repo      shared clone of the repository (cache)
 *   <sha1(repoUrl)>/<id>      one git worktree per session/ticket id
 *
 * Worktrees are created on branch `meepo/<id>` from `origin/<branch>` (or the
 * local branch / explicit commitSha) and reused verbatim when they already exist.
 */
export class WorkspaceManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly baseDir: string) {}

  async ensureWorktree(id: string, spec: WorkspaceSpec): Promise<string> {
    const repoKey = sha1(spec.repoUrl);
    const repoDir = join(this.baseDir, repoKey, 'repo');
    const worktreeDir = join(this.baseDir, repoKey, id);
    if (existsSync(worktreeDir)) return worktreeDir;

    return this.withLock(repoKey, async () => {
      if (existsSync(worktreeDir)) return worktreeDir;
      await this.ensureRepo(repoDir, spec.repoUrl);
      const branch = `meepo/${id}`;
      if (await this.refExists(repoDir, branch)) {
        await this.git(repoDir, ['worktree', 'add', worktreeDir, branch]);
      } else {
        const startPoint = await this.resolveStartPoint(repoDir, spec);
        await this.git(repoDir, ['worktree', 'add', worktreeDir, '-b', branch, startPoint]);
      }
      return worktreeDir;
    });
  }

  private async ensureRepo(repoDir: string, repoUrl: string): Promise<void> {
    if (existsSync(repoDir)) {
      // Best-effort refresh; offline or unreachable remotes must not block reuse.
      await this.git(repoDir, ['fetch', 'origin']).catch(() => undefined);
      return;
    }
    await mkdir(dirname(repoDir), { recursive: true });
    await this.run(['clone', repoUrl, repoDir]);
  }

  private async resolveStartPoint(repoDir: string, spec: WorkspaceSpec): Promise<string> {
    if (spec.commitSha) return spec.commitSha;
    const remoteRef = `origin/${spec.branch}`;
    if (await this.refExists(repoDir, remoteRef)) return remoteRef;
    return spec.branch;
  }

  private async refExists(repoDir: string, ref: string): Promise<boolean> {
    try {
      await this.git(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async git(repoDir: string, args: string[]): Promise<unknown> {
    return this.run(['-C', repoDir, ...args]);
  }

  private readonly run: GitRunner = async (args) => {
    await execFileAsync('git', args);
  };

  /** Serialize git operations per repository: clone/fetch/worktree add mutate shared state. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }
}
