import { createHash } from 'node:crypto';
import type { Channel, ChannelService } from '../../domain/channels/channel-service.js';
import type { StreamRenderHook } from '../../domain/sessions/stream-processor.js';
import type { SessionService } from '../../domain/sessions/session-service.js';

export interface ChannelConnection {
  stop(): void;
  render: StreamRenderHook;
  notify(sessionId: string, text: string): Promise<void>;
}

/** Owns exactly one Feishu long connection per registered app. */
export class ChannelRuntime {
  private readonly live = new Map<string, { fingerprint: string; connection: ChannelConnection }>();
  private syncing?: Promise<void>;
  constructor(
    private readonly channels: ChannelService,
    private readonly sessions: SessionService,
    private readonly create: (channel: Channel) => Promise<ChannelConnection>,
    private readonly onError: (err: unknown) => void
  ) {}

  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncOnce().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  private async syncOnce(): Promise<void> {
    const channels = this.channels.list();
    for (const [id, active] of this.live) {
      if (!channels.some((c) => c.id === id)) {
        active.connection.stop();
        this.live.delete(id);
      }
    }
    for (const channel of channels) {
      const fingerprint = createHash('sha256').update(JSON.stringify(channel)).digest('hex');
      const existing = this.live.get(channel.id);
      if (existing?.fingerprint === fingerprint) continue;
      existing?.connection.stop();
      this.live.delete(channel.id);
      try {
        this.live.set(channel.id, { fingerprint, connection: await this.create(channel) });
      } catch (error) {
        this.onError(error);
      }
    }
  }
  readonly render: StreamRenderHook = (event, ref) => {
    if (ref.kind !== 'session') return;
    void this.sessions
      .getSession(ref.sessionId)
      .then((session) => {
        if (session.channelId) this.live.get(session.channelId)?.connection.render(event, ref);
      })
      .catch(this.onError);
  };
  async notify(sessionId: string, text: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (session.channelId)
      await this.live.get(session.channelId)?.connection.notify(sessionId, text);
  }
  stop(): void {
    for (const entry of this.live.values()) entry.connection.stop();
    this.live.clear();
  }
}
