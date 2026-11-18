import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

describe('loadConfig skillsDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meepo-config-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const base = () => ({
    MEEPO_ENROLLMENT_TOKEN: 'token',
    MEEPO_WORKER_CONFIG: join(dir, 'worker.toml'),
    MEEPO_DATA_DIR: join(dir, 'data'),
  });

  it('defaults to a directory under the data dir, never the personal ~/.agents', () => {
    expect(loadConfig(base()).skillsDir).toBe(join(dir, 'data', 'skills'));
  });

  it('honors MEEPO_SKILLS_DIR', () => {
    expect(loadConfig({ ...base(), MEEPO_SKILLS_DIR: '/opt/skills' }).skillsDir).toBe(
      '/opt/skills'
    );
  });
});

describe('loadConfig project instruction limits', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meepo-config-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const base = () => ({
    MEEPO_ENROLLMENT_TOKEN: 'token',
    MEEPO_WORKER_CONFIG: join(dir, 'worker.toml'),
    MEEPO_DATA_DIR: join(dir, 'data'),
  });

  it('defaults to 16 KiB per file and 32 KiB in total', () => {
    const config = loadConfig(base());
    expect(config.projectInstructionFileBytes).toBe(16 * 1024);
    expect(config.projectInstructionTotalBytes).toBe(32 * 1024);
  });

  it('is configurable and rejects a per-file limit above the total', () => {
    const config = loadConfig({
      ...base(),
      MEEPO_PROJECT_INSTRUCTION_FILE_BYTES: '2048',
      MEEPO_PROJECT_INSTRUCTION_TOTAL_BYTES: '8192',
    });
    expect([config.projectInstructionFileBytes, config.projectInstructionTotalBytes]).toEqual([
      2048, 8192,
    ]);
    expect(() =>
      loadConfig({
        ...base(),
        MEEPO_PROJECT_INSTRUCTION_FILE_BYTES: '8192',
        MEEPO_PROJECT_INSTRUCTION_TOTAL_BYTES: '4096',
      })
    ).toThrow('projectInstructionFileBytes');
  });
});
