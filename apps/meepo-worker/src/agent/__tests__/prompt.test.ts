import { describe, expect, it } from 'vitest';

import { buildBasePrompt } from '../prompt.js';

describe('buildBasePrompt', () => {
  it('tells sessions that their reply reaches the chat window on its own', () => {
    expect(buildBasePrompt('/work')).toContain('delivered to this session');
  });

  it('keeps tickets free of chat delivery rules', () => {
    expect(buildBasePrompt('/work', undefined, false)).not.toContain('chat window');
  });
});
