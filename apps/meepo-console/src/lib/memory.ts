/** Client-side checks mirroring the memory entry rules, so users see problems before saving. */

import type { MemoryMeta } from '../api/types';

/** Route item that opens the creation form; cannot clash with a valid path segment. */
export const NEW_ENTRY = '_new';

export const MEMORY_CONTENT_MAX_BYTES = 65_536;
export const MEMORY_DESCRIPTION_MAX = 200;
export const MEMORY_KEYWORDS_MAX = 10;
export const MEMORY_KEYWORD_MAX_CHARS = 32;
export const MEMORY_ENTRY_CAP = 500;

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateMemoryPath(path: string): string | undefined {
  if (!path) return 'Enter a path made of folders and a note name, separated by “/”.';
  const segments = path.split('/');
  if (segments.length > 5) return 'Use at most 5 folders deep.';
  const bad = segments.find((segment) => !SEGMENT.test(segment));
  if (bad !== undefined)
    return bad === ''
      ? 'Remove empty segments (double or trailing slashes).'
      : `"${bad}" is not valid: use lowercase letters, digits, "-" or "_" (up to 64 characters), starting with a letter or digit.`;
  return undefined;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface WriterLabel {
  text: string;
  /** Console route target when the writer was an agent run. */
  link?: { kind: 'ticket' | 'session'; id: string };
}

/** Who last wrote an entry, in words. */
export function writerLabel(updatedBy: MemoryMeta['updatedBy']): WriterLabel {
  if (updatedBy.kind === 'console') return { text: updatedBy.userId };
  if (updatedBy.sessionId.startsWith('ticket:'))
    return {
      text: 'the agent (ticket)',
      link: { kind: 'ticket', id: updatedBy.sessionId.slice('ticket:'.length) },
    };
  return { text: 'the agent (conversation)', link: { kind: 'session', id: updatedBy.sessionId } };
}
