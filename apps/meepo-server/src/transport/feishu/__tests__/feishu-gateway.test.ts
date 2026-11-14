import { beforeEach, describe, expect, it } from 'vitest';

import type { Space, WorkerNode } from '@meepo/core';
import type { TurnDispatchEnvelope, WorkerChannelDownstream } from '@meepo/protocol';

import { DispatchService } from '../../../domain/dispatch/dispatch-service.js';
import type { WorkerSender } from '../../../domain/dispatch/worker-sender.js';
import type { InboundMessage } from '../../../domain/im/im-router.js';
import { SessionService } from '../../../domain/sessions/session-service.js';
import { TranscriptService } from '../../../domain/sessions/transcript-service.js';
import { MemoryDispatchQueueRepository } from '../../../store/memory/dispatch-queue-memory.js';
import { MemoryRunRepository } from '../../../store/memory/run-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';
import { MemoryWorkerRepository } from '../../../store/memory/worker-memory.js';
import { NoOnlineWorkerError } from '../../../domain/errors.js';
import type { FeishuClient, FeishuMessageEvent, ReplyResult } from '../feishu-client.js';
import { FeishuGateway, normalizeMessage } from '../feishu-gateway.js';

const BOT = 'ou_bot';
const MODEL = { modelId: 'm' };

class FakeFeishuClient implements FeishuClient {
  failNextReply = false;
  readonly replies: {
    messageId: string;
    text: string;
    opts?: { replyInThread?: boolean; uuid?: string };
  }[] = [];
  findReplyCalls = 0;
  /** thread_id handed back for reply_in_thread prewarms */
  prewarmThreadId = 'omt_prewarm';
  threadHistory: import('../feishu-client.js').ThreadHistoryMessage[] = [];
  readonly messages = new Map<string, { sender: string; text: string; chatId: string }>();
  readonly userNames = new Map<string, string>();
  recentMessages: FeishuMessageEvent[] = [];

  async replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean; uuid?: string }
  ): Promise<ReplyResult> {
    if (this.failNextReply) {
      this.failNextReply = false;
      throw new Error('Temporary Feishu failure');
    }
    this.replies.push({ messageId, text, opts });
    return {
      messageId: 'om_reply',
      threadId: opts?.replyInThread ? this.prewarmThreadId : undefined,
    };
  }

  async replyCard(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async createCard(): Promise<string> {
    return 'card_1';
  }
  async updateCard(): Promise<void> {}
  async updateCardSettings(): Promise<void> {}
  async listThreadMessages(): Promise<import('../feishu-client.js').ThreadHistoryMessage[]> {
    return this.threadHistory;
  }

  async getChatName(): Promise<string> {
    return 'oc_group';
  }

  async getMessage(messageId: string) {
    return this.messages.get(messageId);
  }

  async listRecentMessages(): Promise<FeishuMessageEvent[]> {
    return this.recentMessages;
  }

  async getUserName(openId: string): Promise<string> {
    return this.userNames.get(openId) ?? openId;
  }

  async findReply(): Promise<ReplyResult | undefined> {
    this.findReplyCalls++;
    return this.replies.some((reply) => reply.text === '正在处理，请稍候…')
      ? { messageId: 'om_reply', threadId: this.prewarmThreadId }
      : undefined;
  }
}

class FakeSender implements WorkerSender {
  readonly connected = new Set<string>();
  readonly sent: { workerId: string; frame: WorkerChannelDownstream }[] = [];

  isConnected(workerId: string): boolean {
    return this.connected.has(workerId);
  }

  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void {
    this.sent.push({ workerId, frame });
  }

  dispatches(): TurnDispatchEnvelope[] {
    return this.sent
      .filter((item) => 'event' in item.frame && item.frame.event === 'turn.dispatch')
      .map((item) => (item.frame as { payload: TurnDispatchEnvelope }).payload);
  }
}

function makeSpace(id: string, boundChatIds: string[]): Space {
  return {
    id,
    name: id,
    repoUrl: 'https://example.com/repo',
    defaultBranch: 'main',
    timezone: 'UTC',
    model: MODEL,
    boundWorkerId: 'w1',
    boundChatIds,
    requiredTags: [],
    longTermMemory: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeWorker(): WorkerNode {
  return {
    id: 'w1',
    spaceIds: ['sp_group', 'sp_default'],
    hostname: 'w1',
    tags: [],
    maxSlots: 4,
    activeSlots: 0,
    status: 'online',
    lastHeartbeatAt: 0,
    version: '0',
  };
}

function makeMsg(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderName: 'ou_user',
    text: 'hello',
    mentionedOpenIds: [],
    ...overrides,
  };
}

describe('FeishuGateway', () => {
  let client: FakeFeishuClient;
  let sender: FakeSender;
  let gateway: FeishuGateway;
  let sessionService: SessionService;
  let runs: MemoryRunRepository;
  let errors: unknown[];
  const inbox = new Map<string, InboundMessage>();

  beforeEach(async () => {
    inbox.clear();
    errors = [];
    const spaces = new MemorySpaceRepository();
    const sessions = new MemorySessionRepository();
    const sessionEvents = new MemorySessionEventRepository();
    const workers = new MemoryWorkerRepository();
    const tickets = new MemoryTicketRepository();
    const queue = new MemoryDispatchQueueRepository();
    runs = new MemoryRunRepository();
    await spaces.save(makeSpace('sp_group', ['oc_group']));
    await spaces.save(makeSpace('sp_default', []));
    await workers.save(makeWorker());

    sender = new FakeSender();
    sender.connected.add('w1');
    sessionService = new SessionService(sessions, spaces);
    const transcriptService = new TranscriptService(sessionEvents, sessions);
    const dispatchService = new DispatchService(
      sessions,
      spaces,
      workers,
      tickets,
      runs,
      queue,
      sender,
      transcriptService,
      {
        entries: [
          {
            id: 'm',
            provider: 'openai-completions',
            baseUrl: 'https://x',
            apiKey: 'k',
            model: 'm',
          },
        ],
        defaultModelId: 'm',
      }
    );

    client = new FakeFeishuClient();
    gateway = new FeishuGateway({
      inbox: {
        put: (_channel, msg) => {
          inbox.set(msg.messageId, msg);
        },
        pending: () => [...inbox.values()],
        done: (_channel, id) => {
          inbox.delete(id);
        },
      },
      client,
      sessionService,
      dispatchService,
      transcriptService,
      spaces,
      runs,
      botOpenId: BOT,
      defaultSpaceId: 'sp_default',
      onError: (error) => errors.push(error),
    });
  });

  it('prewarms a thread for a main-stream mention, then dispatches a thread session', async () => {
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT], text: 'help me' }));

    expect(client.replies).toHaveLength(1);
    expect(client.replies[0].opts?.replyInThread).toBe(true);

    const session = await sessionService.findByThread('sp_group', 'oc_group', 'omt_prewarm');
    expect(session).toBeDefined();
    expect(session?.kind).toBe('thread');

    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      sessionId: session?.id,
      sessionKind: 'thread',
      delivery: 'wait',
      source: { kind: 'user_message', messageId: 'om_1' },
    });
    expect(dispatches[0].prompt).toContain('<message sender="ou_user" open_id="ou_user"');
    expect(dispatches[0].prompt).toContain('chat="oc_group"');
    expect(dispatches[0].prompt).toContain('help me');

    const snapshot = await sessionService.getSession(session!.id);
    expect(snapshot.status).toBe('active');
  });

  it('dispatches thread follow-ups of an engaged thread into the same session', async () => {
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT] }));
    const session = await sessionService.findByThread('sp_group', 'oc_group', 'omt_prewarm');

    await gateway.handleInbound(
      makeMsg({ messageId: 'om_2', threadId: 'omt_prewarm', text: 'follow up' })
    );

    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toMatchObject({ sessionId: session?.id });
    expect(dispatches[1].prompt).toContain('follow up');
  });

  it('ignores thread messages of threads without an engaged session', async () => {
    await gateway.handleInbound(makeMsg({ threadId: 'omt_stray' }));
    expect(sender.dispatches()).toHaveLength(0);
    expect(client.replies).toHaveLength(0);
  });

  it('rejects /new inside threads but closes a group main session on /new', async () => {
    await gateway.handleInbound(
      makeMsg({ mentionedOpenIds: [BOT], rootId: 'om_root', text: 'reply with mention' })
    );
    const mainSession = (await sessionService.listBySpace('sp_group')).find(
      (s) => s.kind === 'main'
    );
    expect(mainSession).toBeDefined();

    await gateway.handleInbound(
      makeMsg({ messageId: 'om_new_t', threadId: 'omt_x', text: '/new', mentionedOpenIds: [BOT] })
    );
    expect(client.replies.at(-1)?.text).toContain('话题内不支持');
    expect((await sessionService.getSession(mainSession!.id)).status).toBe('active');

    await gateway.handleInbound(
      makeMsg({ messageId: 'om_new', text: '/new', mentionedOpenIds: [BOT] })
    );
    expect((await sessionService.getSession(mainSession!.id)).status).toBe('closed');
    expect(client.replies.at(-1)?.text).toContain('已关闭');
  });

  it('routes main-stream replies mentioning the bot to the group main session', async () => {
    await gateway.handleInbound(
      makeMsg({ mentionedOpenIds: [BOT], rootId: 'om_root', text: 'reply here' })
    );
    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ sessionKind: 'main' });
    expect(dispatches[0].prompt).toContain('reply here');
  });

  it('seeds thread history when a thread session starts from a fresh mention', async () => {
    client.threadHistory = [
      {
        messageId: 'om_h1',
        authorName: 'Aaron',
        content: 'earlier discussion',
        timestamp: 1000,
        isBot: false,
      },
      {
        messageId: 'om_h2',
        authorName: 'ClawFox',
        content: 'bot earlier reply',
        timestamp: 2000,
        isBot: true,
      },
    ];
    await gateway.handleInbound(
      makeMsg({
        messageId: 'om_9',
        threadId: 'omt_fresh',
        mentionedOpenIds: [BOT],
        text: 'join in',
      })
    );

    const sessions = await sessionService.listBySpace('sp_group');
    const session = sessions.find((s) => s.threadId === 'omt_fresh');
    expect(session).toBeDefined();
    const snapshot = await sessionService.listBySpace('sp_group');
    expect(snapshot).toHaveLength(1);

    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain('join in');
  });

  it('lets the origin user abort a run via card action, and rejects others', async () => {
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT], text: 'start' }));
    const session = (await sessionService.listBySpace('sp_group'))[0];
    await runs.save({
      id: 'run1',
      initiatorIds: ['ou_user'],
      work: { kind: 'turn', turnRef: { sessionId: session.id, sourceId: 'legacy' } },
      attempt: 1,
      workerId: 'w1',
      status: 'running',
      createdAt: 0,
    });

    await gateway.handleCardAction({
      operator: { open_id: 'ou_other' },
      action: { value: { action: 'abort_run', runId: 'run1' } },
    });
    expect(
      sender.sent.filter((s) => s.frame.kind === 'notification' && s.frame.event === 'run.abort')
    ).toHaveLength(0);

    await gateway.handleCardAction({
      operator: { open_id: 'ou_user' },
      action: { value: { action: 'abort_run', runId: 'run1' } },
    });
    const aborts = sender.sent.filter(
      (s) => s.frame.kind === 'notification' && s.frame.event === 'run.abort'
    );
    expect(aborts).toHaveLength(1);
    expect(aborts[0].workerId).toBe('w1');
  });

  it('replies when /new has no active session in the window', async () => {
    await gateway.handleInbound(makeMsg({ text: '/new', mentionedOpenIds: [BOT] }));
    expect(client.replies.at(-1)?.text).toContain('没有进行中的会话');
    expect(sender.dispatches()).toHaveLength(0);
  });

  it('routes private chats to a main session in the default space and keeps it stable', async () => {
    await gateway.handleInbound(makeMsg({ chatType: 'p2p', chatId: 'oc_p2p', text: 'hi' }));
    await gateway.handleInbound(
      makeMsg({ messageId: 'om_2', chatType: 'p2p', chatId: 'oc_p2p', text: 'more' })
    );

    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]).toMatchObject({ sessionKind: 'main', spaceId: 'sp_default' });
    expect(dispatches[1].sessionId).toBe(dispatches[0].sessionId);
  });

  it('drops duplicate deliveries of the same message_id', async () => {
    const msg = makeMsg({ mentionedOpenIds: [BOT] });
    await gateway.handleInbound(msg);
    await gateway.handleInbound(msg);
    expect(sender.dispatches()).toHaveLength(1);
    expect(client.replies).toHaveLength(1);
  });

  it('ignores group main-stream messages that do not mention the bot', async () => {
    await gateway.handleInbound(makeMsg());
    expect(sender.dispatches()).toHaveLength(0);
  });
  it('retries a persisted inbound after a transient prewarm failure', async () => {
    client.failNextReply = true;
    const message = makeMsg({ mentionedOpenIds: [BOT] });
    await expect(gateway.handleInbound(message)).rejects.toThrow('Temporary Feishu failure');
    expect(inbox.size).toBe(1);
    await gateway.recover();
    expect(inbox.size).toBe(0);
    expect(sender.dispatches()).toHaveLength(1);
    await gateway.handleInbound(message);
    expect(sender.dispatches()).toHaveLength(1);
    expect(client.replies).toHaveLength(1);
  });

  it('attributes turns to the resolved display name and keeps the open_id', async () => {
    client.userNames.set('ou_user', 'Alice');
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT], text: 'hi' }));
    expect(sender.dispatches()[0].prompt).toContain('sender="Alice" open_id="ou_user"');
  });

  it('quotes an explicit reply target', async () => {
    client.messages.set('om_target', { sender: 'Bob', text: 'original words', chatId: 'oc_group' });
    await gateway.handleInbound(
      makeMsg({ mentionedOpenIds: [BOT], rootId: 'om_target', parentId: 'om_target', text: 'ok' })
    );
    expect(sender.dispatches()[0].prompt).toContain('original words');
  });

  it('answers unsupported message types in private chats with a notice instead of a turn', async () => {
    await gateway.handleInbound(
      makeMsg({ chatType: 'p2p', chatId: 'oc_p2p', text: '', unsupportedType: 'file' })
    );
    expect(sender.dispatches()).toHaveLength(0);
    expect(client.replies).toHaveLength(1);
    expect(client.replies[0].text).toContain('「file」');
    // A redelivered event must not produce a second notice on Feishu's side.
    expect(client.replies[0].opts?.uuid).toBeTruthy();
  });

  it('forwards post images with the turn', async () => {
    await gateway.handleInbound(
      makeMsg({
        chatType: 'p2p',
        chatId: 'oc_p2p',
        text: 'look [Image]',
        images: [{ messageId: 'om_1', fileKey: 'img_1' }],
      })
    );
    expect(sender.dispatches()[0].images).toEqual([{ messageId: 'om_1', fileKey: 'img_1' }]);
  });

  describe('backfill after downtime', () => {
    const textEvent = (id: string, text: string, extra?: Partial<FeishuMessageEvent['message']>) =>
      makeEvent({
        message_id: id,
        content: JSON.stringify({ text }),
        mentions: text.includes('@_user_1')
          ? [{ key: '@_user_1', name: 'bot', id: { open_id: BOT } }]
          : undefined,
        ...extra,
      });

    it('answers missed @bot messages, skips chatter and commands, and does not repeat', async () => {
      client.recentMessages = [
        textEvent('om_missed', '@_user_1 missed question'),
        textEvent('om_chatter', 'people talking'),
        textEvent('om_new', '@_user_1 /new'),
      ];

      await gateway.backfill();
      await gateway.backfill();

      const dispatches = sender.dispatches();
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].prompt).toContain('missed question');
      expect(client.replies.every((reply) => !reply.text.includes('/new'))).toBe(true);
      expect(errors).toEqual([]);
    });

    it('answers missed messages of an engaged thread without a mention', async () => {
      await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT] }));
      client.recentMessages = [
        textEvent('om_late', 'follow up while down', { thread_id: 'omt_prewarm', root_id: 'om_1' }),
      ];

      await gateway.backfill();

      expect(sender.dispatches()).toHaveLength(2);
      expect(sender.dispatches()[1].prompt).toContain('follow up while down');
    });
  });

  describe('when no worker is online', () => {
    const offlineNotices = () =>
      client.replies.filter((reply) => reply.text.includes('没有在线的 worker'));

    it('tells a thread user once, retries quietly and processes the message on return', async () => {
      sender.connected.delete('w1');
      const message = makeMsg({ mentionedOpenIds: [BOT] });

      await expect(gateway.handleInbound(message)).rejects.toBeInstanceOf(NoOnlineWorkerError);
      await gateway.recover();
      await gateway.recover();

      expect(offlineNotices()).toHaveLength(1);
      expect(offlineNotices()[0].opts?.replyInThread).toBe(true);
      expect(errors).toEqual([]);
      expect(sender.dispatches()).toHaveLength(0);

      // Retries reuse the thread spawned by the first attempt instead of searching Feishu again.
      expect(client.findReplyCalls).toBe(1);
      expect(client.replies.filter((reply) => reply.text === '正在处理，请稍候…')).toHaveLength(1);

      sender.connected.add('w1');
      await gateway.recover();
      expect(sender.dispatches()).toHaveLength(1);
      expect(inbox.size).toBe(0);
      expect(offlineNotices()).toHaveLength(1);
    });

    it('tells a private-chat user that the queued message waits for the worker', async () => {
      sender.connected.delete('w1');
      await gateway.handleInbound(makeMsg({ chatType: 'p2p', chatId: 'oc_p2p', text: 'hi' }));

      expect(offlineNotices()).toHaveLength(1);
      expect(offlineNotices()[0].opts?.replyInThread).toBe(false);
      expect(sender.dispatches()).toHaveLength(0);
    });
  });
});

function makeEvent(
  overrides: Partial<FeishuMessageEvent['message']> & { content: string }
): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      ...overrides,
    },
  };
}

describe('normalizeMessage', () => {
  const text = (value: string) => JSON.stringify({ text: value });

  it('drops the implicit thread-root parent_id but keeps real quotes', () => {
    const implicit = normalizeMessage(
      makeEvent({
        content: text('hi'),
        thread_id: 'omt_1',
        root_id: 'om_root',
        parent_id: 'om_root',
      })
    );
    expect(implicit).toMatchObject({ threadId: 'omt_1', rootId: 'om_root', parentId: undefined });

    const quote = normalizeMessage(
      makeEvent({
        content: text('hi'),
        thread_id: 'omt_1',
        root_id: 'om_root',
        parent_id: 'om_other',
      })
    );
    expect(quote?.parentId).toBe('om_other');

    const mainStreamReply = normalizeMessage(
      makeEvent({ content: text('hi'), root_id: 'om_root', parent_id: 'om_root' })
    );
    expect(mainStreamReply?.parentId).toBe('om_root');
  });

  it('flattens post messages into text, mentions and images', () => {
    const post = {
      title: 'Report',
      content: [
        [
          { tag: 'at', user_id: '@_user_1', user_name: 'ClawFox' },
          { tag: 'text', text: ' please read ' },
          { tag: 'a', text: 'the doc', href: 'https://example.com/doc' },
        ],
        [{ tag: 'img', image_key: 'img_a' }],
        [{ tag: 'md', text: '**bold** <at user_id="@_user_1">ClawFox</at>' }],
        [{ tag: 'code_block', language: 'TS', text: 'const a = 1;' }],
      ],
    };
    const msg = normalizeMessage(
      makeEvent({
        message_type: 'post',
        content: JSON.stringify(post),
        mentions: [{ key: '@_user_1', name: 'ClawFox', id: { open_id: 'ou_bot' } }],
      })
    );

    expect(msg?.mentionedOpenIds).toEqual(['ou_bot']);
    expect(msg?.images).toEqual([{ messageId: 'om_1', fileKey: 'img_a' }]);
    expect(msg?.text).toBe(
      [
        'Report',
        '@ClawFox please read [the doc](https://example.com/doc)',
        '[Image]',
        '**bold** @ClawFox',
        '```ts\nconst a = 1;\n```',
      ].join('\n')
    );
  });

  it("strips the bot's own mention but keeps other people's and bare mentions", () => {
    const mentions = [
      { key: '@_user_1', name: 'ClawFox', id: { open_id: 'ou_bot' } },
      { key: '@_user_2', name: 'Alice', id: { open_id: 'ou_alice' } },
    ];
    const withText = normalizeMessage(
      makeEvent({ content: text('@_user_1 ask @_user_2 about it'), mentions }),
      'ou_bot'
    );
    expect(withText?.text).toBe('ask @Alice about it');
    expect(withText?.mentionedOpenIds).toEqual(['ou_bot', 'ou_alice']);

    const bare = normalizeMessage(makeEvent({ content: text('@_user_1'), mentions }), 'ou_bot');
    expect(bare?.text).toBe('@ClawFox');

    const unknownBot = normalizeMessage(makeEvent({ content: text('@_user_1 hi'), mentions }));
    expect(unknownBot?.text).toBe('@ClawFox hi');
  });

  it('names post mentions that carry a real id instead of a mention key', () => {
    const post = {
      content: [
        [
          { tag: 'at', user_id: 'ou_alice', user_name: 'Alice' },
          { tag: 'text', text: ' hi' },
        ],
      ],
    };
    const msg = normalizeMessage(
      makeEvent({ message_type: 'post', content: JSON.stringify(post) })
    );
    expect(msg?.text).toBe('@Alice hi');
  });

  it('accepts post content wrapped in a locale key and rejects empty posts', () => {
    const wrapped = normalizeMessage(
      makeEvent({
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: { title: '', content: [[{ tag: 'text', text: 'hello' }]] },
        }),
      })
    );
    expect(wrapped?.text).toBe('hello');
    expect(
      normalizeMessage(
        makeEvent({ message_type: 'post', content: JSON.stringify({ content: [] }) })
      )
    ).toBeNull();
  });

  it('marks unreadable message types instead of dropping them', () => {
    const msg = normalizeMessage(
      makeEvent({ message_type: 'file', content: JSON.stringify({ file_key: 'f' }) })
    );
    expect(msg).toMatchObject({ unsupportedType: 'file', text: '' });
  });

  it('rejects malformed bodies of readable types', () => {
    expect(normalizeMessage(makeEvent({ content: 'not json' }))).toBeNull();
    expect(normalizeMessage(makeEvent({ content: 'null' }))).toBeNull();
    expect(normalizeMessage(makeEvent({ message_type: 'image', content: '{}' }))).toBeNull();
  });
});
