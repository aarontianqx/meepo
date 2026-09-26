import type { Space } from '@meepo/core';
import type { Database } from 'better-sqlite3';

import type { SpaceRepository } from '../../domain/spaces/space-repository.js';

interface SpaceRow {
  id: string;
  name: string;
  description: string | null;
  repo_url: string;
  default_branch: string;
  bound_worker_id: string | null;
  timezone: string;
  model_id: string | null;
  model_thinking_level: string | null;
  bound_chat_ids: string;
  required_tags: string;
  long_term_memory: string;
  created_at: number;
  updated_at: number;
}

function rowToSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    boundWorkerId: row.bound_worker_id ?? undefined,
    timezone: row.timezone,
    model:
      row.model_id != null
        ? {
            modelId: row.model_id,
            thinkingLevel: (row.model_thinking_level ?? undefined) as
              'low' | 'high' | 'max' | undefined,
          }
        : undefined,
    boundChatIds: JSON.parse(row.bound_chat_ids) as string[],
    requiredTags: JSON.parse(row.required_tags) as string[],
    longTermMemory: row.long_term_memory,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSpaceRepository implements SpaceRepository {
  constructor(private readonly db: Database) {}

  async save(space: Space): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO spaces (
          id, name, description, repo_url, default_branch, bound_worker_id,
          timezone, model_id, model_thinking_level,
          bound_chat_ids, required_tags, long_term_memory, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        space.id,
        space.name,
        space.description ?? null,
        space.repoUrl,
        space.defaultBranch,
        space.boundWorkerId ?? null,
        space.timezone,
        space.model?.modelId ?? null,
        space.model?.thinkingLevel ?? null,
        JSON.stringify(space.boundChatIds),
        JSON.stringify(space.requiredTags),
        space.longTermMemory,
        space.createdAt,
        space.updatedAt
      );
  }

  async getById(id: string): Promise<Space | undefined> {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as
      SpaceRow | undefined;
    return row ? rowToSpace(row) : undefined;
  }

  async list(): Promise<Space[]> {
    const rows = this.db.prepare('SELECT * FROM spaces').all() as SpaceRow[];
    return rows.map(rowToSpace);
  }
}
