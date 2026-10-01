import { randomUUID } from 'node:crypto';
import { notFound, validation } from '../errors.js';
import type { SpaceRepository } from '../spaces/space-repository.js';

export interface Channel {
  id: string;
  type: 'feishu';
  appId: string;
  appSecret: string;
  name: string;
  spaceId: string;
  allowedOpenIds: string[];
  boundChatIds: string[];
  updatedAt: number;
}

export interface ChannelRepository {
  list(): Channel[];
  get(id: string): Channel | undefined;
  save(channel: Channel): void;
  delete(id: string): void;
  TxMigrateLegacySessions(channelId: string, spaceId: string): void;
}

export class ChannelService {
  constructor(
    private readonly repository: ChannelRepository,
    private readonly spaces: SpaceRepository
  ) {}

  list(): Channel[] {
    return this.repository.list();
  }
  get(id: string): Channel {
    const channel = this.repository.get(id);
    if (!channel) throw notFound(`Channel not found: ${id}`);
    return channel;
  }
  async save(input: Omit<Channel, 'id' | 'updatedAt'> & { id?: string }): Promise<Channel> {
    if (typeof input.name !== 'string' || !input.name.trim())
      throw validation('Channel name is required');
    if (
      !Array.isArray(input.allowedOpenIds) ||
      !Array.isArray(input.boundChatIds) ||
      [...input.allowedOpenIds, ...input.boundChatIds].some(
        (id) => typeof id !== 'string' || !id.trim()
      )
    )
      throw validation('Chat and user allowlists must be arrays of nonempty IDs');
    if (input.type !== 'feishu') throw validation('Only Feishu channels are supported');
    if (
      typeof input.appId !== 'string' ||
      typeof input.appSecret !== 'string' ||
      !input.appId.trim() ||
      !input.appSecret.trim()
    )
      throw validation('Channel appId and appSecret are required');
    if (!(await this.spaces.getById(input.spaceId)))
      throw validation('Channel must bind to an existing space');
    if (this.list().some((c) => c.appId === input.appId && c.id !== input.id))
      throw validation('App already registered');
    const channel = { ...input, id: input.id ?? randomUUID(), updatedAt: Date.now() };
    this.repository.save(channel);
    return channel;
  }
  async bindChats(spaceId: string, channelId: string, chatIds: string[]): Promise<void> {
    if (!Array.isArray(chatIds)) throw validation('chatIds must be an array');
    const channel = this.get(channelId);
    if (channel.spaceId !== spaceId) throw notFound('Channel not found in this space');
    await this.save({ ...channel, boundChatIds: [...new Set(chatIds)] });
  }
  delete(id: string): void {
    this.get(id);
    this.repository.delete(id);
  }

  async importEnvironment(config?: {
    appId: string;
    appSecret: string;
    defaultSpaceId?: string;
  }): Promise<void> {
    if (!config || this.list().some((c) => c.appId === config.appId)) return;
    if (!config.defaultSpaceId) {
      console.warn('Skipping legacy channel import: MEEPO_DEFAULT_SPACE_ID is unset');
      return;
    }
    const space = await this.spaces.getById(config.defaultSpaceId);
    if (!space) {
      console.warn('Skipping legacy channel import: default space does not exist');
      return;
    }
    const channel = await this.save({
      type: 'feishu',
      appId: config.appId,
      appSecret: config.appSecret,
      name: 'ClawFox',
      spaceId: space.id,
      allowedOpenIds: [],
      boundChatIds: space.boundChatIds,
    });
    this.repository.TxMigrateLegacySessions(channel.id, space.id);
  }
}

export function publicChannel(channel: Channel): Omit<Channel, 'appSecret'> {
  const { appSecret: _secret, ...publicFields } = channel;
  return publicFields;
}
