import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha1, WorkspaceManager } from '../workspace-manager.js';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', ['-C', cwd, ...args]);

let root: string;
let originDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'meepo-ws-test-'));
  const seedDir = join(root, 'seed');
  await mkdir(seedDir);
  await git(seedDir, ['init', '-b', 'main']);
  await writeFile(join(seedDir, 'hello.txt'), 'hello meepo');
  await git(seedDir, ['add', '.']);
  await git(seedDir, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=test',
    'commit',
    '-m',
    'init',
  ]);
  originDir = join(root, 'origin.git');
  await exec('git', ['clone', '--bare', seedDir, originDir]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('WorkspaceManager', () => {
  it('clones the repo cache and creates a worktree on a meepo/<id> branch', async () => {
    const baseDir = join(root, 'workspaces');
    const manager = new WorkspaceManager(baseDir);

    const dir = await manager.ensureWorktree('sess-1', { repoUrl: originDir, branch: 'main' });

    expect(dir).toBe(join(baseDir, sha1(originDir), 'sess-1'));
    expect(existsSync(join(dir, 'hello.txt'))).toBe(true);
    const repoDir = join(baseDir, sha1(originDir), 'repo');
    expect(existsSync(repoDir)).toBe(true);
    const { stdout } = await git(repoDir, ['branch', '--list', 'meepo/sess-1']);
    expect(stdout.trim()).not.toBe('');
  }, 60_000);

  it('reuses an existing worktree and isolates different ids', async () => {
    const baseDir = join(root, 'workspaces');
    const manager = new WorkspaceManager(baseDir);
    const spec = { repoUrl: originDir, branch: 'main' };

    const first = await manager.ensureWorktree('sess-1', spec);
    await writeFile(join(first, 'marker.txt'), 'keep');

    const again = await manager.ensureWorktree('sess-1', spec);
    expect(again).toBe(first);
    expect(await readFile(join(again, 'marker.txt'), 'utf8')).toBe('keep');

    const other = await manager.ensureWorktree('sess-2', spec);
    expect(other).not.toBe(first);
    expect(existsSync(join(other, 'hello.txt'))).toBe(true);
    expect(existsSync(join(other, 'marker.txt'))).toBe(false);
  }, 60_000);
});
