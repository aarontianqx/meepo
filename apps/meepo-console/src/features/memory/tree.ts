// Builds the folder tree shown in the memory sidebar from flat entry paths.

import type { MemoryMeta } from '../../api/types';

export interface TreeNode {
  /** Last path segment. */
  name: string;
  /** Full path up to and including this node. */
  path: string;
  /** Present when an entry lives exactly at this path (a node can also have children). */
  entry?: MemoryMeta;
  children: TreeNode[];
  /** Number of entries in this subtree, including this node's own. */
  count: number;
}

/** Folders first, then entries, each alphabetical; pinned entries lead their level. */
export function buildTree(entries: MemoryMeta[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], count: 0 };
  for (const entry of entries) {
    let node = root;
    let path = '';
    for (const segment of entry.path.split('/')) {
      path = path ? `${path}/${segment}` : segment;
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path, children: [], count: 0 };
        node.children.push(child);
      }
      child.count += 1;
      node = child;
    }
    node.entry = entry;
  }
  sortLevel(root.children);
  return root.children;
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.children.length > 0 ? 0 : 1;
    const bFolder = b.children.length > 0 ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    const aPinned = a.entry?.pinned ? 0 : 1;
    const bPinned = b.entry?.pinned ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortLevel(node.children);
}
