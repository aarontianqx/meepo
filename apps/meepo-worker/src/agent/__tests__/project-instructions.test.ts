import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TOOL_PAYLOAD_BYTES, type CanonicalEvent } from '@meepo/protocol';
import {
  DEFAULT_PROJECT_INSTRUCTION_LIMITS,
  instructionMarkersInEvents,
  ProjectInstructionTracker,
  withCarryOver,
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
    await writeFile(
      join(repo, 'AGENTS.md'),
      'x'.repeat(DEFAULT_PROJECT_INSTRUCTION_LIMITS.fileBytes + 100)
    );
    const text = await touch(new ProjectInstructionTracker(workDir), repo);
    expect(Buffer.byteLength(text!)).toBeLessThan(
      DEFAULT_PROJECT_INSTRUCTION_LIMITS.fileBytes + 1024
    );
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

describe('project instruction carry-over at compaction', () => {
  let base: string;
  let workDir: string;
  let repo: string;
  let other: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'meepo-carry-')));
    workDir = join(base, 'work');
    repo = join(base, 'repo');
    other = join(base, 'other');
    for (const dir of [workDir, join(repo, '.git'), join(repo, 'pkg'), join(other, '.git')])
      await mkdir(dir, { recursive: true });
    await writeFile(join(repo, 'AGENTS.md'), 'REPO ROOT');
    await writeFile(join(repo, 'pkg', 'AGENTS.md'), 'REPO PKG');
    await writeFile(join(other, 'AGENTS.md'), 'OTHER ROOT');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const toolResult = (text: string): AgentMessage => ({
    role: 'toolResult',
    toolCallId: 't',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  });
  const summary = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });

  it('carries every worked-in project, root files first and the latest project first', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    await tracker.discover('read', { path: join(repo, 'pkg') }, 0);
    await tracker.discover('read', { path: other }, 0);
    const carried = await tracker.carryOver([]);
    expect(carried).toContain('[Project instructions carried over]');
    const order = ['OTHER ROOT', 'REPO ROOT', 'REPO PKG'].map((s) => carried!.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it('reads fresh content from disk and skips files that vanished', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    await tracker.discover('read', { path: join(repo, 'pkg') }, 0);
    await writeFile(join(repo, 'AGENTS.md'), 'REPO ROOT v2');
    await rm(join(repo, 'pkg', 'AGENTS.md'));
    const carried = await tracker.carryOver([]);
    expect(carried).toContain('REPO ROOT v2');
    expect(carried).not.toContain('REPO PKG');
  });

  it('skips a file whose current content the retained tail still holds', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    const delivered = await tracker.discover('read', { path: join(repo, 'pkg') }, 0);
    const tail = [toolResult(`body\n${delivered}`)];
    expect(await tracker.carryOver(tail)).toBeUndefined();

    await writeFile(join(repo, 'AGENTS.md'), 'REPO ROOT v2');
    const carried = await tracker.carryOver(tail);
    expect(carried).toContain('REPO ROOT v2');
    expect(carried).not.toContain('REPO PKG');
  });

  it('delivers again on the next touch what a compaction left out of the history', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    await tracker.discover('read', { path: other }, 0);
    await tracker.carryOver([]);
    // Carried instructions live in the summary now; a later touch must not repeat them.
    expect(await tracker.discover('read', { path: other }, 0)).toBeUndefined();

    await rm(join(other, 'AGENTS.md'));
    await tracker.carryOver([]); // nothing carried: the old text is gone from the history
    await writeFile(join(other, 'AGENTS.md'), 'OTHER ROOT');
    expect(await tracker.discover('read', { path: other }, 0)).toContain('OTHER ROOT');
  });

  it('truncates each file and stops at the total budget', async () => {
    await writeFile(join(repo, 'AGENTS.md'), 'a'.repeat(3000));
    await writeFile(join(other, 'AGENTS.md'), 'b'.repeat(3000));
    await writeFile(join(repo, 'pkg', 'AGENTS.md'), 'c'.repeat(3000));
    const tracker = new ProjectInstructionTracker(workDir, { fileBytes: 2048, totalBytes: 4500 });
    await tracker.discover('read', { path: join(repo, 'pkg') }, 0);
    await tracker.discover('read', { path: other }, 0);
    const carried = await tracker.carryOver([]);
    expect(carried).toContain('[truncated; read');
    expect(carried).toContain('b'.repeat(100));
    expect(carried).toContain('a'.repeat(100));
    expect(carried).not.toContain('c'.repeat(100));
  });

  it('rebuilds known files from restored events, including ones a compaction dropped', async () => {
    const delivered = await new ProjectInstructionTracker(workDir).discover(
      'read',
      { path: other },
      0
    );
    const tracker = new ProjectInstructionTracker(workDir);
    tracker.restoreMarkers(
      instructionMarkersInEvents([
        {
          type: 'tool_result',
          payload: { result: { content: [{ type: 'text', text: delivered }] } },
        },
      ] as CanonicalEvent[])
    );
    expect(await tracker.discover('read', { path: other }, 0)).toBeUndefined();
    expect(await tracker.carryOver([])).toContain('OTHER ROOT');
  });

  it('announces the active project only when it changes', async () => {
    const tracker = new ProjectInstructionTracker(workDir);
    expect(tracker.activeProjectNote()).toBeUndefined();
    await tracker.discover('read', { path: repo }, 0);
    expect(tracker.activeProjectNote()).toBe(`<active-project root=${JSON.stringify(repo)}/>`);
    expect(tracker.activeProjectNote()).toBeUndefined();
    await tracker.discover('read', { path: other }, 0);
    expect(tracker.activeProjectNote()).toBe(`<active-project root=${JSON.stringify(other)}/>`);
    await tracker.discover('read', { path: repo }, 0);
    expect(tracker.activeProjectNote()).toBe(`<active-project root=${JSON.stringify(repo)}/>`);
    await tracker.carryOver([]);
    expect(tracker.activeProjectNote()).toBe(`<active-project root=${JSON.stringify(repo)}/>`);
  });

  it('merges carried text into a summary, inside a system note when there is one', () => {
    expect(withCarryOver(summary('[Summary of the earlier conversation]\nS'), 'C')).toMatchObject({
      content: '[Summary of the earlier conversation]\nS\n\nC',
    });
    expect(
      withCarryOver(summary('<system_note>[Summary of earlier events]\nS</system_note>'), 'C')
    ).toMatchObject({ content: '<system_note>[Summary of earlier events]\nS\n\nC</system_note>' });
  });
});
