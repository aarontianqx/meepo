import { describe, expect, it } from 'vitest';

import type * as lark from '@larksuiteoapi/node-sdk';

import { LarkFeishuClient, messageText, readableBody } from '../feishu-client.js';

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

describe('readableBody', () => {
  const body = (value: unknown) => ({ content: JSON.stringify(value) });

  it('reads the key of an image message', () => {
    expect(readableBody({ msg_type: 'image', body: body({ image_key: 'img_1' }) })).toEqual({
      text: '',
      imageKeys: ['img_1'],
    });
  });

  it('returns the text and the image keys of a post', () => {
    expect(
      readableBody({
        msg_type: 'post',
        body: body({ content: [[{ tag: 'text', text: 'see' }], [{ tag: 'img', image_key: 'a' }]] }),
      })?.imageKeys
    ).toEqual(['a']);
  });

  it('returns undefined for other types, an image without a key, and malformed bodies', () => {
    expect(readableBody({ msg_type: 'file', body: body({ file_key: 'f' }) })).toBeUndefined();
    expect(readableBody({ msg_type: 'image', body: body({}) })).toBeUndefined();
    expect(readableBody({ msg_type: 'text', body: { content: 'not json' } })).toBeUndefined();
  });
});

describe('LarkFeishuClient.listMainStreamMessages', () => {
  type Item = Record<string, unknown>;
  const sender = (id: string, type = 'user') => ({ id, sender_type: type });
  const item = (id: string, createTime: number, extra: Item = {}): Item => ({
    message_id: id,
    msg_type: 'text',
    create_time: String(createTime),
    sender: sender('ou_alice'),
    body: { content: JSON.stringify({ text: `text of ${id}` }) },
    ...extra,
  });

  function clientWith(pages: { items: Item[]; hasMore?: boolean }[]) {
    const params: Item[] = [];
    let call = 0;
    const stub = {
      im: {
        v1: {
          message: {
            list: async (req: { params: Item }) => {
              params.push(req.params);
              const page = pages[call++];
              return {
                code: 0,
                data: { items: page.items, has_more: page.hasMore, page_token: `t${call}` },
              };
            },
          },
        },
      },
      contact: { v3: { user: { get: async () => ({ data: { user: { name: 'Alice' } } }) } } },
    };
    return { client: new LarkFeishuClient(stub as unknown as lark.Client), params };
  }

  const range = { since: 1_000_000, before: 2_000_000, excludeMessageId: 'om_trigger', limit: 30 };

  it('reports who each message @mentions', async () => {
    const { client } = clientWith([
      {
        items: [
          item('om_1', 1_200_000, {
            mentions: [{ key: '@_user_1', id: 'ou_bot', name: 'ClawFox' }],
          }),
        ],
      },
    ]);
    const result = await client.listMainStreamMessages('oc_group', range);
    expect(result.messages[0].mentionedOpenIds).toEqual(['ou_bot']);
  });

  it('returns main-stream messages oldest first with names, and asks Feishu for the window', async () => {
    const { client, params } = clientWith([
      { items: [item('om_2', 1_500_000), item('om_1', 1_200_000, { thread_id: 'omt_1' })] },
    ]);
    const result = await client.listMainStreamMessages('oc_group', range);
    expect(result.moreAvailable).toBe(false);
    expect(result.messages.map((m) => m.messageId)).toEqual(['om_1', 'om_2']);
    expect(result.messages[0]).toMatchObject({
      authorName: 'Alice',
      authorOpenId: 'ou_alice',
      content: 'text of om_1',
      timestamp: 1_200_000,
      hasThread: true,
      mentionedOpenIds: [],
    });
    expect(params[0]).toMatchObject({
      container_id_type: 'chat',
      container_id: 'oc_group',
      start_time: '1000',
      end_time: '2000',
      sort_type: 'ByCreateTimeDesc',
    });
  });

  it('skips thread replies, apps, deleted messages, the trigger and anything outside the window', async () => {
    const { client } = clientWith([
      {
        items: [
          item('om_keep', 1_500_000),
          item('om_reply', 1_500_000, { thread_id: 'omt_1', root_id: 'om_1' }),
          item('om_app', 1_500_000, { sender: sender('cli_bot', 'app') }),
          item('om_deleted', 1_500_000, { deleted: true }),
          item('om_trigger', 1_500_000),
          item('om_late', 2_000_000),
          item('om_early', 999_000),
        ],
      },
    ]);
    const result = await client.listMainStreamMessages('oc_group', range);
    expect(result.messages.map((m) => m.messageId)).toEqual(['om_keep']);
  });

  it('shows images and unreadable types as placeholders', async () => {
    const { client } = clientWith([
      {
        items: [
          item('om_file', 1_600_000, { msg_type: 'file', body: { content: '{}' } }),
          item('om_img', 1_500_000, {
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'k' }) },
          }),
        ],
      },
    ]);
    const result = await client.listMainStreamMessages('oc_group', range);
    expect(result.messages.map((m) => m.content)).toEqual(['[图片]', '[file]']);
  });

  it('follows pages and reports more messages when the limit is exceeded', async () => {
    const page = (from: number) => ({
      items: Array.from({ length: 2 }, (_, i) => item(`om_${from + i}`, 1_900_000 - (from + i))),
      hasMore: true,
    });
    const { client, params } = clientWith([page(0), page(2), page(4)]);
    const result = await client.listMainStreamMessages('oc_group', { ...range, limit: 3 });
    expect(params).toHaveLength(2);
    expect(result.moreAvailable).toBe(true);
  });

  it('reports more messages when the page cap is reached with pages left', async () => {
    const page = (from: number) => ({
      items: [item(`om_${from}`, 1_900_000 - from)],
      hasMore: true,
    });
    const { client, params } = clientWith([page(0), page(1), page(2)]);
    const result = await client.listMainStreamMessages('oc_group', range);
    expect(params).toHaveLength(3);
    expect(result.moreAvailable).toBe(true);
  });
});
