import { beforeEach, describe, expect, it } from 'vitest';

import type { Space, WorkerNode } from '@meepo/core';
import type { SessionDispatchEnvelope, WorkerChannelDownstream } from '@meepo/protocol';

import { DispatchService } from '../../../domain/dispatch/dispatch-service.js';
import type { WorkerSender } from '../../../domain/dispatch/worker-sender.js';
import type { InboundMessage } from '../../../domain/im/im-router.js';
import { SessionService } from '../../../domain/sessions/session-service.js';
import { TranscriptService } from '../../../domain/sessions/transcript-service.js';
import { MemoryDispatchQueueRepository } from '../../../store/memory/dispatch-queue-memory.js';
import { MemorySessionEventRepository } from '../../../store/memory/session-event-memory.js';
import { MemorySessionRepository } from '../../../store/memory/session-memory.js';
import { MemorySpaceRepository } from '../../../store/memory/space-memory.js';
import { MemoryTicketRepository } from '../../../store/memory/ticket-memory.js';
import { MemoryWorkerRepository } from '../../../store/memory/worker-memory.js';
import type { FeishuClient, ReplyResult } from '../feishu-client.js';
import { FeishuGateway } from '../feishu-gateway.js';

const BOT = 'ou_bot';
const MODEL = { provider: 'openai-completions', baseUrl: 'https://x', apiKey: 'k', model: 'm' };

class FakeFeishuClient implements FeishuClient {
  readonly replies: { messageId: string; text: string; opts?: { replyInThread?: boolean } }[] = [];
  /** thread_id handed back for reply_in_thread prewarms */
  prewarmThreadId = 'omt_prewarm';

  async replyText(
    messageId: string,
    text: string,
    opts?: { replyInThread?: boolean }
  ): Promise<ReplyResult> {
    this.replies.push({ messageId, text, opts });
    return {
      messageId: 'om_reply',
      threadId: opts?.replyInThread ? this.prewarmThreadId : undefined,
    };
  }

  async replyCard(): Promise<void> {}
  async createCard(): Promise<string> {
    return 'card_1';
  }
  async updateCardContent(): Promise<void> {}
  async updateCardSettings(): Promise<void> {}
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

  dispatches(): SessionDispatchEnvelope[] {
    return this.sent
      .filter((item) => 'event' in item.frame && item.frame.event === 'session.dispatch')
      .map((item) => (item.frame as { payload: SessionDispatchEnvelope }).payload);
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

  beforeEach(async () => {
    const spaces = new MemorySpaceRepository();
    const sessions = new MemorySessionRepository();
    const sessionEvents = new MemorySessionEventRepository();
    const workers = new MemoryWorkerRepository();
    const tickets = new MemoryTicketRepository();
    const queue = new MemoryDispatchQueueRepository();
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
      queue,
      sender,
      transcriptService,
      MODEL
    );

    client = new FakeFeishuClient();
    gateway = new FeishuGateway({
      client,
      sessionService,
      dispatchService,
      spaces,
      botOpenId: BOT,
      defaultSpaceId: 'sp_default',
    });
  });

  it('prewarms a thread for a main-stream mention, then dispatches a task session', async () => {
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT], text: 'help me' }));

    expect(client.replies).toHaveLength(1);
    expect(client.replies[0].opts?.replyInThread).toBe(true);

    const session = await sessionService.findByThread('sp_group', 'oc_group', 'omt_prewarm');
    expect(session).toBeDefined();
    expect(session?.kind).toBe('task');

    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      sessionId: session?.id,
      sessionKind: 'task',
      prompt: 'help me',
      delivery: 'wait',
      source: { kind: 'user_message', messageId: 'om_1' },
    });

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
    expect(dispatches[1]).toMatchObject({ sessionId: session?.id, prompt: 'follow up' });
  });

  it('ignores thread messages of threads without an engaged session', async () => {
    await gateway.handleInbound(makeMsg({ threadId: 'omt_stray' }));
    expect(sender.dispatches()).toHaveLength(0);
    expect(client.replies).toHaveLength(0);
  });

  it('closes the window session on /new and starts fresh on the next message', async () => {
    await gateway.handleInbound(makeMsg({ mentionedOpenIds: [BOT] }));
    const first = await sessionService.findByThread('sp_group', 'oc_group', 'omt_prewarm');
    expect(first).toBeDefined();

    await gateway.handleInbound(
      makeMsg({ messageId: 'om_new', threadId: 'omt_prewarm', text: '/new' })
    );
    expect((await sessionService.getSession(first!.id)).status).toBe('closed');
    expect(client.replies.at(-1)?.text).toContain('已关闭');
    expect(sender.dispatches()).toHaveLength(1);

    await gateway.handleInbound(
      makeMsg({
        messageId: 'om_3',
        threadId: 'omt_prewarm',
        text: 'again',
        mentionedOpenIds: [BOT],
      })
    );
    const dispatches = sender.dispatches();
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].sessionId).not.toBe(first!.id);
  });

  it('replies when /new has no active session in the window', async () => {
    await gateway.handleInbound(makeMsg({ text: '/new' }));
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
});
