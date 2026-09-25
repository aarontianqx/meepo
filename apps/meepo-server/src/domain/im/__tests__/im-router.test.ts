import { describe, expect, it } from 'vitest';

import {
  decideInbound,
  GROUP_MAIN_SUB_ID,
  windowIdOf,
  type InboundContext,
  type InboundMessage,
} from '../im-router.js';

const BOT = 'ou_bot';

function makeMsg(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'm1',
    chatId: 'chat1',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderName: 'Aaron',
    text: 'hello',
    mentionedOpenIds: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<InboundContext>): InboundContext {
  return {
    botOpenId: BOT,
    spaceIdForChat: (chatId) => (chatId === 'chat1' ? 'sp1' : undefined),
    defaultSpaceId: 'sp-default',
    sessionExistsForWindow: () => false,
    seenMessage: () => false,
    ...overrides,
  };
}

describe('decideInbound', () => {
  it('ignores duplicates', () => {
    const decision = decideInbound(makeMsg(), makeCtx({ seenMessage: () => true }));
    expect(decision.action).toBe('ignore');
  });

  it('ignores unbound group chats', () => {
    const decision = decideInbound(makeMsg({ chatId: 'stray' }), makeCtx());
    expect(decision).toMatchObject({ action: 'ignore', reason: 'chat is not bound to any space' });
  });

  it('ignores main-stream messages without a mention', () => {
    expect(decideInbound(makeMsg(), makeCtx()).action).toBe('ignore');
  });

  it('ignores mentions that target only other bots', () => {
    const decision = decideInbound(makeMsg({ mentionedOpenIds: ['ou_other'] }), makeCtx());
    expect(decision).toMatchObject({ action: 'ignore', reason: 'mention targets another bot' });
  });

  it('prewarms a thread for a fresh main-stream mention', () => {
    const decision = decideInbound(makeMsg({ mentionedOpenIds: [BOT] }), makeCtx());
    expect(decision).toMatchObject({
      action: 'dispatch',
      threadRef: { kind: 'prewarm' },
      sessionKind: 'task',
      spaceId: 'sp1',
    });
  });

  it('routes a main-stream reply mentioning the bot to the group main session', () => {
    const decision = decideInbound(
      makeMsg({ mentionedOpenIds: [BOT], rootId: 'om_root', parentId: 'om_parent' }),
      makeCtx()
    );
    expect(decision).toMatchObject({
      action: 'dispatch',
      windowId: windowIdOf('chat1', GROUP_MAIN_SUB_ID),
      sessionKind: 'main',
      seedThreadHistory: false,
    });
  });

  it('ignores main-stream replies without a mention', () => {
    const decision = decideInbound(makeMsg({ rootId: 'om_root' }), makeCtx());
    expect(decision.action).toBe('ignore');
  });

  it('answers thread replies in engaged threads without seeding history', () => {
    const threadMsg = makeMsg({ threadId: 'omt_1' });
    const engaged = makeCtx({
      sessionExistsForWindow: (windowId) => windowId === windowIdOf('chat1', 'omt_1'),
    });
    const decision = decideInbound(threadMsg, engaged);
    expect(decision).toMatchObject({
      action: 'dispatch',
      threadRef: { kind: 'thread', threadId: 'omt_1' },
      sessionKind: 'task',
      seedThreadHistory: false,
    });
  });

  it('seeds history when a thread session starts from a fresh mention', () => {
    const decision = decideInbound(
      makeMsg({ threadId: 'omt_2', mentionedOpenIds: [BOT] }),
      makeCtx()
    );
    expect(decision).toMatchObject({
      action: 'dispatch',
      sessionKind: 'task',
      seedThreadHistory: true,
    });
  });

  it('ignores unengaged thread messages without a mention', () => {
    expect(decideInbound(makeMsg({ threadId: 'omt_3' }), makeCtx()).action).toBe('ignore');
  });

  it('answers every private-chat message as a main session in the default space', () => {
    const decision = decideInbound(makeMsg({ chatType: 'p2p' }), makeCtx());
    expect(decision).toMatchObject({
      action: 'dispatch',
      sessionKind: 'main',
      spaceId: 'sp-default',
      windowId: windowIdOf('chat1', 'ou_user'),
    });
  });

  it('ignores private chats when no default space is configured', () => {
    const decision = decideInbound(
      makeMsg({ chatType: 'p2p' }),
      makeCtx({ defaultSpaceId: undefined })
    );
    expect(decision.action).toBe('ignore');
  });
});
