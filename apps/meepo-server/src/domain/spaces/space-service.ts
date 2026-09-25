import { randomUUID } from 'node:crypto';

import type { Space } from '@meepo/core';

import { notFound, validation } from '../errors.js';
import type { MembershipService } from '../memberships/membership-service.js';
import type { WorkerRepository } from '../workers/worker-repository.js';
import type { SpaceRepository } from './space-repository.js';

export interface CreateSpaceInput {
  name: string;
  description?: string;
  repoUrl: string;
  defaultBranch?: string;
  requiredTags?: string[];
  timezone?: string;
}

export interface UpdateSpaceInput {
  description?: string;
  repoUrl?: string;
  defaultBranch?: string;
  requiredTags?: string[];
  timezone?: string;
}

const DEFAULT_TIMEZONE = 'UTC';

export class SpaceService {
  constructor(
    private readonly spaces: SpaceRepository,
    private readonly memberships: MembershipService,
    private readonly workers: WorkerRepository
  ) {}

  /** Creates a space and makes the creator its owner. */
  async createSpace(input: CreateSpaceInput, userId: string): Promise<Space> {
    if (!input.name.trim()) throw validation('Space name must not be empty');
    if (!input.repoUrl.trim()) throw validation('Space repoUrl must not be empty');
    const now = Date.now();
    const space: Space = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description,
      repoUrl: input.repoUrl.trim(),
      defaultBranch: input.defaultBranch ?? 'main',
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      boundChatIds: [],
      requiredTags: input.requiredTags ?? [],
      longTermMemory: '',
      createdAt: now,
      updatedAt: now,
    };
    await this.spaces.save(space);
    await this.memberships.addOwner(space.id, userId);
    return space;
  }

  async getSpace(id: string): Promise<Space> {
    const space = await this.spaces.getById(id);
    if (!space) throw notFound(`Space not found: ${id}`);
    return space;
  }

  /** Lists spaces visible to the user: all spaces the user is a member of. */
  async listSpaces(userId: string): Promise<Space[]> {
    const memberships = await this.memberships.listMemberships(userId);
    const spaces = await Promise.all(memberships.map((m) => this.spaces.getById(m.spaceId)));
    return spaces.filter((space): space is Space => space !== undefined);
  }

  async bindChat(spaceId: string, chatId: string, userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const space = await this.getSpace(spaceId);
    if (!chatId.trim()) throw validation('chatId must not be empty');
    if (!space.boundChatIds.includes(chatId)) {
      space.boundChatIds.push(chatId);
      space.updatedAt = Date.now();
      await this.spaces.save(space);
    }
    return space;
  }

  async unbindChat(spaceId: string, chatId: string, userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const space = await this.getSpace(spaceId);
    space.boundChatIds = space.boundChatIds.filter((id) => id !== chatId);
    space.updatedAt = Date.now();
    await this.spaces.save(space);
    return space;
  }

  async updateMemory(spaceId: string, longTermMemory: string, userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const space = await this.getSpace(spaceId);
    space.longTermMemory = longTermMemory;
    space.updatedAt = Date.now();
    await this.spaces.save(space);
    return space;
  }

  /** Sets (or clears) the space's server-held model credentials. */
  async updateModel(spaceId: string, model: Space['model'], userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const space = await this.getSpace(spaceId);
    space.model = model;
    space.updatedAt = Date.now();
    await this.spaces.save(space);
    return space;
  }

  /** Partially updates editable space fields. */
  async updateSpace(spaceId: string, patch: UpdateSpaceInput, userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const space = await this.getSpace(spaceId);
    if (patch.description !== undefined) space.description = patch.description;
    if (patch.repoUrl !== undefined) {
      if (!patch.repoUrl.trim()) throw validation('Space repoUrl must not be empty');
      space.repoUrl = patch.repoUrl.trim();
    }
    if (patch.defaultBranch !== undefined) space.defaultBranch = patch.defaultBranch;
    if (patch.requiredTags !== undefined) space.requiredTags = patch.requiredTags;
    if (patch.timezone !== undefined) space.timezone = patch.timezone;
    space.updatedAt = Date.now();
    await this.spaces.save(space);
    return space;
  }

  /**
   * Switches the space's worker binding — the only way main sessions migrate.
   * The target worker must be enrolled for this space.
   */
  async switchBinding(spaceId: string, workerId: string, userId: string): Promise<Space> {
    await this.memberships.requireManager(spaceId, userId);
    const worker = await this.workers.getById(workerId);
    if (!worker || !worker.spaceIds.includes(spaceId)) {
      throw validation(`Worker ${workerId} is not enrolled for space ${spaceId}`);
    }
    const space = await this.getSpace(spaceId);
    space.boundWorkerId = workerId;
    space.updatedAt = Date.now();
    await this.spaces.save(space);
    return space;
  }

  /** Default binding rule: the first enrolled worker to register wins the binding. */
  async bindWorkerIfUnbound(spaceId: string, workerId: string): Promise<void> {
    const space = await this.spaces.getById(spaceId);
    if (!space || space.boundWorkerId !== undefined) return;
    space.boundWorkerId = workerId;
    space.updatedAt = Date.now();
    await this.spaces.save(space);
  }
}
