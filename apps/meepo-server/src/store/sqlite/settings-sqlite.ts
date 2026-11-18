import type { Database } from 'better-sqlite3';

import type { SettingsRepository } from '../../domain/settings/settings-service.js';

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .run(key, value, Date.now());
  }
}
