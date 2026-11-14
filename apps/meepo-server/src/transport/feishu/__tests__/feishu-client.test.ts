import { describe, expect, it } from 'vitest';

import { messageText } from '../feishu-client.js';

describe('messageText', () => {
  const body = (value: unknown) => ({ content: JSON.stringify(value) });

  it('replaces mention keys in text messages and falls back to the key without a name', () => {
    expect(
      messageText({
        msg_type: 'text',
        body: body({ text: '@_user_1 ask @_user_2' }),
        mentions: [
          { key: '@_user_1', name: 'Alice' },
          { key: '@_user_2', name: '' },
        ],
      })
    ).toBe('@Alice ask @_user_2');
  });

  it('flattens post messages, so thread history keeps rich-text turns', () => {
    expect(
      messageText({
        msg_type: 'post',
        body: body({
          title: 'T',
          content: [
            [
              { tag: 'at', user_id: '@_user_1' },
              { tag: 'text', text: ' hi' },
            ],
          ],
        }),
        mentions: [{ key: '@_user_1', name: 'Alice' }],
      })
    ).toBe('T\n@Alice hi');
  });

  it('returns an empty string for other types and malformed bodies', () => {
    expect(messageText({ msg_type: 'image', body: body({ image_key: 'k' }) })).toBe('');
    expect(messageText({ msg_type: 'text', body: { content: 'not json' } })).toBe('');
  });
});
