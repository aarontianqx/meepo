import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOOL_PAYLOAD_BYTES } from '@meepo/protocol';
import {
  PROJECT_INSTRUCTIONS_FILE_BYTES,
  ProjectInstructionTracker,
  withProjectInstructions,
} from '../project-instructions.js';
import type { AnyAgentTool } from '../tools.js';

describe('project instruction discovery', () => {
  let base: string;
  let workDir: string;
  let repo: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'meepo-projects-')));
    workDir = join(base, 'work');
    repo = join(base, 'repo');
    await mkdir(workDir, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'pkg', 'inner'), { recursive: true });
    await writeFile(join(repo, 'AGENTS.md'), 'ROOT RULES');
    await writeFile(join(repo, 'pkg', 'AGENTS.md'), 'PKG RULES');
    await writeFile(join(repo, 'pkg', 'inner', 'file.ts'), 'code');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const touch = (tracker: ProjectInstructionTracker, path: string, bytes = 0) =>
    tracker.discover('read', { path }, bytes);

  it('appends the project root and nested AGENTS.md, root first, with source markers', async () => {
    const text = await touch(
      new ProjectInstructionTracker(workDir),
      join(repo, 'pkg', 'inner', 'file.ts')
    );
    expect(text).toContain(
      `[Project instructions: ${join(repo, 'AGENTS.md')} (project ${repo}, sha256:`
    );
    expect(text).toContain(`applies to files under ${join(repo, 'pkg')}]\nPKG RULES`);
    expect(text!.indexOf('ROOT RULES')).toBeLessThan(text!.indexOf('PKG RULES'));
  });

  it('does not repeat instructions the model has seen, but resends a changed file', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    const file = join(repo, 'pkg', 'inner', 'file.ts');
    expect(await touch(tracker, file)).toBeDefined();
    expect(await touch(tracker, file)).toBeUndefined();
    expect(await touch(tracker, join(repo, 'pkg'))).toBeUndefined();

    await writeFile(join(repo, 'AGENTS.md'), 'ROOT RULES v2');
    const again = await touch(tracker, file);
    expect(again).toContain('ROOT RULES v2');
    expect(again).not.toContain('PKG RULES');
  });

  it('ignores missing paths and anything outside a git project and the working directory', async () => {
    const outside = join(base, 'plain');
    await mkdir(outside);
    await writeFile(join(outside, 'AGENTS.md'), 'NOT A PROJECT');
    const tracker = new ProjectInstructionTracker(workDir);
    expect(await touch(tracker, join(repo, 'missing.ts'))).toBeUndefined();
    expect(await touch(tracker, outside)).toBeUndefined();
    expect(await tracker.discover('read', {}, 0)).toBeUndefined();
    expect(await tracker.discover('MemoryRead', { path: repo }, 0)).toBeUndefined();
  });

  it('reads the working directory instructions when it is not a git project', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'SCRATCH RULES');
    await mkdir(join(workDir, 'notes'));
    const text = await touch(new ProjectInstructionTracker(workDir), join(workDir, 'notes'));
    expect(text).toContain('SCRATCH RULES');
  });

  it('resolves relative tool paths against the working directory', async () => {
    await mkdir(join(workDir, 'sub'));
    await mkdir(join(workDir, 'sub', '.git'));
    await writeFile(join(workDir, 'sub', 'AGENTS.md'), 'SUB RULES');
    const text = await touch(new ProjectInstructionTracker(workDir), 'sub/x');
    expect(text).toBeUndefined(); // x does not exist
    expect(await touch(new ProjectInstructionTracker(workDir), 'sub')).toContain('SUB RULES');
  });

  it('finds projects through shell commands: cd targets, absolute and relative paths', async () => {
    const run = (command: string) =>
      new ProjectInstructionTracker(workDir).discover('bash', { command }, 0);
    expect(await run(`cd ${repo}/pkg && npm test`)).toContain('PKG RULES');
    expect(await run(`cat "${repo}/pkg/inner/file.ts" | wc -l`)).toContain('ROOT RULES');
    expect(await run('ls ../repo && echo done')).toContain('ROOT RULES'); // relative to work/
    expect(await run(`ls ${repo}/ ; curl https://example.com/a/b`)).toContain('ROOT RULES');
    expect(await run('echo hello > /dev/null')).toBeUndefined();
  });

  it('truncates a large file and names the file to read for the rest', async () => {
    await writeFile(join(repo, 'AGENTS.md'), 'x'.repeat(PROJECT_INSTRUCTIONS_FILE_BYTES + 100));
    const text = await touch(new ProjectInstructionTracker(workDir), repo);
    expect(Buffer.byteLength(text!)).toBeLessThan(PROJECT_INSTRUCTIONS_FILE_BYTES + 1024);
    expect(text).toContain(`[truncated; read ${join(repo, 'AGENTS.md')} for the rest]`);
  });

  it('defers instructions that would push the tool result over the journal bound', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    expect(await touch(tracker, repo, TOOL_PAYLOAD_BYTES - 5)).toBeUndefined();
    // Nothing was delivered, so the next touch still delivers them.
    expect(await touch(tracker, repo)).toContain('ROOT RULES');
  });

  it('remembers what a restored conversation already contains', async () => {
    const first = new ProjectInstructionTracker(workDir);
    const delivered = await touch(first, join(repo, 'pkg'));
    const restored = new ProjectInstructionTracker(workDir);
    restored.restore([
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: `file contents\n${delivered}` }],
        isError: false,
        timestamp: 1,
      },
    ]);
    expect(await touch(restored, join(repo, 'pkg'))).toBeUndefined();
  });
});

describe('withProjectInstructions', () => {
  let base: string;
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'meepo-wrap-')));
    await mkdir(join(base, 'repo', '.git'), { recursive: true });
    await writeFile(join(base, 'repo', 'AGENTS.md'), 'RULES');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const tool = (execute: AnyAgentTool['execute']): AnyAgentTool =>
    ({ name: 'read', label: 'read', description: 'read', parameters: {}, execute }) as AnyAgentTool;

  it('appends instructions as an extra content block after the tool result', async () => {
    const wrapped = withProjectInstructions(
      [tool(async () => ({ content: [{ type: 'text', text: 'file body' }], details: undefined }))],
      new ProjectInstructionTracker(base)
    );
    const result = await wrapped[0].execute('1', { path: join(base, 'repo') });
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'file body' });
    expect(JSON.stringify(result.content[1])).toContain('RULES');
  });

  it('leaves a failing tool failing and never fails a tool because discovery failed', async () => {
    const failing = withProjectInstructions(
      [
        tool(async () => {
          throw new Error('boom');
        }),
      ],
      new ProjectInstructionTracker(base)
    );
    await expect(failing[0].execute('1', { path: join(base, 'repo') })).rejects.toThrow('boom');

    const tracker = new ProjectInstructionTracker(base);
    tracker.discover = async () => {
      throw new Error('discovery broke');
    };
    const wrapped = withProjectInstructions(
      [tool(async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }))],
      tracker
    );
    const result = await wrapped[0].execute('1', { path: base });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
