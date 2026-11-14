import { createCodingTools } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codingToolOptions, withoutWorkerVariables } from '../tool-env.js';

describe('tool subprocess environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('drops MEEPO_* variables and keeps the rest', () => {
    expect(
      withoutWorkerVariables({ MEEPO_ENROLLMENT_TOKEN: 'x', meepo_server_url: 'y', PATH: '/bin' })
    ).toEqual({ PATH: '/bin' });
  });

  it('keeps the enrollment token out of bash commands', async () => {
    vi.stubEnv('MEEPO_ENROLLMENT_TOKEN', 'secret-token');
    vi.stubEnv('MEEPO_TEST_VISIBLE_VARIABLE', 'plain');
    vi.stubEnv('UNRELATED_TEST_VARIABLE', 'kept');
    const bash = createCodingTools(process.cwd(), codingToolOptions).find(
      (t) => t.name === 'bash'
    )!;

    const result = await bash.execute('call', {
      command:
        'echo "token=[$MEEPO_ENROLLMENT_TOKEN] other=[$MEEPO_TEST_VISIBLE_VARIABLE] kept=[$UNRELATED_TEST_VARIABLE]"',
    });

    expect(JSON.stringify(result)).toContain('token=[] other=[] kept=[kept]');
  });
});
