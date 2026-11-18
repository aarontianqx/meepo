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
