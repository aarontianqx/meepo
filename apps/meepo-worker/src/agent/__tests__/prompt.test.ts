import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBasePrompt, renderPrompt } from '../prompt.js';

describe('buildBasePrompt', () => {
  it('tells sessions that their reply reaches the chat window on its own', () => {
    expect(buildBasePrompt('/work')).toContain('delivered to this session');
  });

  it('keeps tickets free of chat delivery rules', () => {
    expect(buildBasePrompt('/work', undefined, false)).not.toContain('chat window');
  });
});

describe('renderPrompt skill index', () => {
  const prepared = { base: 'base', memoryMap: '', memoryMapVersion: 1 };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meepo-skills-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function writeSkill(name: string, front: string): Promise<void> {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'SKILL.md'), `---\n${front}\n---\nbody\n`);
  }

  it('lists skills sorted by name and hides model-invocation-disabled ones', async () => {
    await writeSkill('zeta', 'name: zeta\ndescription: last one');
    await writeSkill('alpha', 'name: alpha\ndescription: first one');
    await writeSkill('hidden', 'name: hidden\ndescription: nope\ndisable-model-invocation: true');
    const prompt = await renderPrompt('/work', prepared, [], { skillsDir: dir });
    const lines = prompt.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('- alpha: first one');
    expect(lines[1]).toContain('- zeta: last one');
    expect(prompt).not.toContain('hidden');
  });

  it('adds no skill section without a skills directory or when it is missing', async () => {
    expect(await renderPrompt('/work', prepared, [])).not.toContain('Available skills');
    expect(
      await renderPrompt('/work', prepared, [], { skillsDir: join(dir, 'missing') })
    ).not.toContain('Available skills');
  });
});
