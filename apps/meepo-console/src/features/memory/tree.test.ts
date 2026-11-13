import { describe, expect, it } from 'vitest';

import type { MemoryMeta } from '../../api/types';
import { buildTree } from './tree';

const entry = (path: string, pinned = false): MemoryMeta => ({
  path,
  description: '',
  keywords: [],
  revision: 1,
  pinned,
  updatedAt: 0,
  updatedBy: { kind: 'console', userId: 'u' },
});

describe('buildTree', () => {
  it('nests entries by folder and counts each subtree', () => {
    const tree = buildTree([entry('playbooks/a'), entry('playbooks/deep/b'), entry('notes')]);
    const playbooks = tree.find((n) => n.name === 'playbooks');
    expect(playbooks).toMatchObject({ path: 'playbooks', count: 2 });
    expect(playbooks?.children.map((c) => c.path)).toEqual(['playbooks/deep', 'playbooks/a']);
    expect(tree.find((n) => n.name === 'notes')?.entry?.path).toBe('notes');
  });

  it('lists folders before entries, then pinned, then alphabetical', () => {
    const tree = buildTree([entry('zeta'), entry('alpha'), entry('pin', true), entry('dir/x')]);
    expect(tree.map((n) => n.name)).toEqual(['dir', 'pin', 'alpha', 'zeta']);
  });

  it('lets a node be both an entry and a folder', () => {
    const [node] = buildTree([entry('a'), entry('a/b')]);
    expect(node.entry?.path).toBe('a');
    expect(node.children).toHaveLength(1);
    expect(node.count).toBe(2);
  });
});
