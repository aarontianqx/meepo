import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE spaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          repo_url TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          bound_worker_id TEXT,
          timezone TEXT NOT NULL,
          bound_chat_ids TEXT NOT NULL,
          required_tags TEXT NOT NULL,
          long_term_memory TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE workers (
          id TEXT PRIMARY KEY,
          space_ids TEXT NOT NULL,
          hostname TEXT NOT NULL,
          tags TEXT NOT NULL,
          max_slots INTEGER NOT NULL,
          active_slots INTEGER NOT NULL,
          status TEXT NOT NULL,
          last_heartbeat_at INTEGER NOT NULL,
          version TEXT NOT NULL
        );

        CREATE TABLE tickets (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          context_summary TEXT,
          required_tags TEXT NOT NULL,
          status TEXT NOT NULL,
          assigned_worker_id TEXT,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          bound_worker_id TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL
        );

        CREATE TABLE session_events (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          PRIMARY KEY (session_id, seq)
        );

        CREATE TABLE memberships (
          space_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (space_id, user_id)
        );

        CREATE TABLE enrollment_tokens (
          id TEXT PRIMARY KEY,
          space_ids TEXT NOT NULL,
          issued_by_user_id TEXT NOT NULL,
          label TEXT,
          token TEXT NOT NULL UNIQUE,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    name: 'schedule and dispatch queue',
    up(db) {
      db.exec(`
        CREATE TABLE reminders (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          context_summary TEXT,
          required_tags TEXT NOT NULL,
          trigger TEXT NOT NULL,
          timezone TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by_user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_fired_at INTEGER
        );

        CREATE TABLE cron_jobs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          cron TEXT NOT NULL,
          prompt TEXT NOT NULL,
          recurring INTEGER NOT NULL,
          timezone TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_fired_at INTEGER
        );

        CREATE TABLE dispatch_queue (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          envelope TEXT NOT NULL,
          queued_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'session anchor message',
    up(db) {
      db.exec('ALTER TABLE sessions ADD COLUMN anchor_message_id TEXT');
    },
  },
  {
    version: 4,
    name: 'ticket workspace binding',
    up(db) {
      db.exec('ALTER TABLE tickets ADD COLUMN workspace TEXT');
    },
  },
  {
    version: 5,
    name: 'drop ticket workspace binding',
    up(db) {
      db.exec('ALTER TABLE tickets DROP COLUMN workspace');
    },
  },
];

/** Applies pending migrations in version order, tracking progress via `user_version`. */
export function runMigrations(db: Database, list: Migration[] = migrations): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = list.filter((migration) => migration.version > current);
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
