import { describe, expect, it } from 'vitest';

import { byteLength, validateMemoryPath, writerLabel } from './memory';

describe('validateMemoryPath', () => {
  it('accepts nested lowercase paths up to five folders', () => {
    expect(validateMemoryPath('playbooks/weekly-report')).toBeUndefined();
    expect(validateMemoryPath('a/b/c/d/e')).toBeUndefined();
  });

  it('rejects empty, too deep, empty-segment and invalid-character paths', () => {
    expect(validateMemoryPath('')).toContain('Enter a path');
    expect(validateMemoryPath('a/b/c/d/e/f')).toContain('at most 5');
    expect(validateMemoryPath('a//b')).toContain('empty segments');
    expect(validateMemoryPath('a/')).toContain('empty segments');
    expect(validateMemoryPath('Upper')).toContain('"Upper" is not valid');
    expect(validateMemoryPath('-lead')).toContain('is not valid');
  });
});

describe('byteLength', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('你好')).toBe(6);
  });
});

describe('writerLabel', () => {
  it('names console users and links agent writers to their ticket or session', () => {
    expect(writerLabel({ kind: 'console', userId: 'mia' })).toEqual({ text: 'mia' });
    expect(writerLabel({ kind: 'agent', sessionId: 'ticket:t1' })).toMatchObject({
      link: { kind: 'ticket', id: 't1' },
    });
    expect(writerLabel({ kind: 'agent', sessionId: 's1' })).toMatchObject({
      link: { kind: 'session', id: 's1' },
    });
  });
});
