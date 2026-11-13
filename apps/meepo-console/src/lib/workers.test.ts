import type { WorkerNode } from '@meepo/core';
import { describe, expect, it } from 'vitest';

import type { EnrollmentRecord } from '../api/types';
import { reusableWorkers } from './workers';

const NOW = 1_000_000;

function enrollment(overrides: Partial<EnrollmentRecord>): EnrollmentRecord {
  return {
    id: 'e1',
    spaceIds: ['a'],
    issuedByUserId: 'me',
    workerId: 'w1',
    createdAt: 1,
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerNode>): WorkerNode {
  return {
    id: 'w1',
    spaceIds: ['a'],
    hostname: 'host',
    tags: [],
    maxSlots: 1,
    activeSlots: 0,
    status: 'online',
    lastHeartbeatAt: NOW,
    version: '1',
    ...overrides,
  };
}

describe('reusableWorkers', () => {
  it('lists workers whose live token does not cover the space yet', () => {
    const result = reusableWorkers([enrollment({})], [worker({})], 'b', NOW);
    expect(result.map((r) => r.worker.id)).toEqual(['w1']);
  });

  it('skips tokens that cannot be extended or never reached a worker', () => {
    const tokens = [
      enrollment({ id: 'covered', workerId: 'w1', spaceIds: ['a', 'b'] }),
      enrollment({ id: 'revoked', workerId: 'w2', revokedAt: 5 }),
      enrollment({ id: 'expired', workerId: 'w3', expiresAt: NOW }),
      enrollment({ id: 'unused', workerId: undefined }),
      enrollment({ id: 'hidden', workerId: 'w9' }),
    ];
    const workers = ['w1', 'w2', 'w3'].map((id) => worker({ id }));
    expect(reusableWorkers(tokens, workers, 'b', NOW)).toEqual([]);
  });

  it('puts online workers first, then sorts by hostname', () => {
    const tokens = ['w1', 'w2', 'w3'].map((id) => enrollment({ id: `e-${id}`, workerId: id }));
    const workers = [
      worker({ id: 'w1', hostname: 'a-offline', status: 'offline' }),
      worker({ id: 'w2', hostname: 'z-online' }),
      worker({ id: 'w3', hostname: 'b-online', status: 'busy' }),
    ];
    expect(reusableWorkers(tokens, workers, 'b', NOW).map((r) => r.worker.hostname)).toEqual([
      'b-online',
      'z-online',
      'a-offline',
    ]);
  });
});
