import { createHash } from 'node:crypto';
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
  {
    version: 6,
    name: 'unified schedules and runs',
    up(db) {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          timing TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by_user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_fired_at INTEGER
        );

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          work TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          worker_id TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );

        ALTER TABLE tickets ADD COLUMN origin_session_id TEXT;

        DROP TABLE reminders;
        DROP TABLE cron_jobs;
      `);
    },
  },
  {
    version: 7,
    name: 'session prewarm message',
    up(db) {
      db.exec('ALTER TABLE sessions ADD COLUMN prewarm_message_id TEXT');
    },
  },
  {
    version: 8,
    name: 'space model reference',
    up(db) {
      db.exec(`
        ALTER TABLE spaces ADD COLUMN model_id TEXT;
        ALTER TABLE spaces ADD COLUMN model_thinking_level TEXT;
      `);
    },
  },
  {
    version: 9,
    name: 'v2 durable execution journal',
    up(db) {
      db.exec(`
        ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
        ALTER TABLE runs ADD COLUMN terminal_reason TEXT;
        ALTER TABLE runs ADD COLUMN last_client_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN usage TEXT;
        ALTER TABLE runs ADD COLUMN initiator_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE runs ADD COLUMN merged_source_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE runs ADD COLUMN merged_into_run_id TEXT;
        UPDATE runs SET work = json_object('kind', 'turn', 'turnRef', json_object('sessionId', json_extract(work, '$.sessionId'), 'sourceId', id))
          WHERE json_extract(work, '$.kind') = 'turn';
        ALTER TABLE session_events ADD COLUMN run_id TEXT;
        ALTER TABLE session_events ADD COLUMN client_seq INTEGER;
        CREATE UNIQUE INDEX session_event_client_seq ON session_events(run_id, client_seq) WHERE run_id IS NOT NULL;
        CREATE TABLE run_events (
          run_id TEXT NOT NULL REFERENCES runs(id), client_seq INTEGER NOT NULL,
          type TEXT NOT NULL, payload TEXT NOT NULL, timestamp INTEGER NOT NULL,
          PRIMARY KEY (run_id, client_seq)
        );
        CREATE TABLE processed_messages (channel_id TEXT NOT NULL, message_id TEXT NOT NULL, processed_at INTEGER NOT NULL, PRIMARY KEY(channel_id, message_id));
        CREATE INDEX processed_messages_age ON processed_messages(processed_at);
        CREATE INDEX runs_lease ON runs(status, lease_expires_at);
      `);
    },
  },
  {
    version: 10,
    name: 'channel registry and isolated window mappings',
    up(db) {
      db.exec(`
        CREATE TABLE channels (id TEXT PRIMARY KEY, app_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, app_secret TEXT NOT NULL);
        ALTER TABLE sessions ADD COLUMN channel_id TEXT NOT NULL DEFAULT '';
        UPDATE sessions SET status = 'closed' WHERE id IN (
          SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY space_id, channel_id, chat_id, thread_id ORDER BY last_active_at DESC, id DESC) AS rank
          FROM sessions WHERE status != 'closed') WHERE rank > 1
        );
        CREATE UNIQUE INDEX active_window ON sessions(space_id, channel_id, chat_id, thread_id) WHERE status != 'closed';
      `);
    },
  },

  {
    version: 11,
    name: 'ticket retry metadata and enrollment lifecycle',
    up(db) {
      db.exec(`
        UPDATE memberships SET role = 'operator' WHERE role = 'manager';
        CREATE TABLE ticket_receipts (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE schedule_fires (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, work_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        ALTER TABLE tickets ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tickets ADD COLUMN idempotent INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tickets ADD COLUMN terminal_reason TEXT;
        UPDATE tickets SET attempt = COALESCE((SELECT MAX(attempt) FROM runs WHERE json_extract(work, '$.ticketId') = tickets.id), 0);
        ALTER TABLE enrollment_tokens ADD COLUMN revoked_at INTEGER;
        ALTER TABLE enrollment_tokens ADD COLUMN worker_id TEXT;
      `);
      const tokens = db.prepare('SELECT id, token FROM enrollment_tokens').all() as {
        id: string;
        token: string;
      }[];
      for (const token of tokens) {
        db.prepare('UPDATE enrollment_tokens SET token = ? WHERE id = ?').run(
          'sha256:' + createHash('sha256').update(token.token).digest('hex'),
          token.id
        );
      }
    },
  },

  {
    version: 12,
    name: 'structured space memory with trigram search',
    up(db) {
      db.exec(`
        CREATE TABLE server_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ALTER TABLE spaces ADD COLUMN prompt_preset TEXT;
        CREATE TABLE memory_entries (space_id TEXT NOT NULL, path TEXT NOT NULL, description TEXT NOT NULL, keywords TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(space_id,path));
        CREATE VIRTUAL TABLE memory_fts USING fts5(path,description,keywords,content,content='memory_entries',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER memory_insert AFTER INSERT ON memory_entries BEGIN
          INSERT INTO memory_fts(rowid,path,description,keywords,content) VALUES(new.rowid,new.path,new.description,new.keywords,new.content);
        END;
        CREATE TRIGGER memory_update AFTER UPDATE ON memory_entries BEGIN
          INSERT INTO memory_fts(memory_fts,rowid,path,description,keywords,content) VALUES('delete',old.rowid,old.path,old.description,old.keywords,old.content);
          INSERT INTO memory_fts(rowid,path,description,keywords,content) VALUES(new.rowid,new.path,new.description,new.keywords,new.content);
        END;
        INSERT INTO memory_entries(space_id,path,description,keywords,content,revision,pinned,updated_at,updated_by)
          SELECT id,'legacy/notes','Imported space notes','[]',long_term_memory,1,0,updated_at,'{"kind":"console","userId":"migration"}' FROM spaces WHERE length(trim(long_term_memory)) > 0;
      `);
    },
  },
  {
    version: 13,
    name: 'durable outbound card projections',
    up(db) {
      db.exec(
        `CREATE TABLE card_outbox(run_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, data TEXT NOT NULL, pending INTEGER NOT NULL);`
      );
    },
  },
  {
    version: 14,
    name: 'transactional command reply outbox',
    up(db) {
      db.exec(
        `CREATE TABLE message_outbox(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,sent INTEGER NOT NULL DEFAULT 0);`
      );
    },
  },
  {
    version: 15,
    name: 'durable inbound retry',
    up(db) {
      db.exec(
        'CREATE TABLE inbound_inbox(channel_id TEXT NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(channel_id,message_id))'
      );
    },
  },
  {
    version: 16,
    name: 'space webhook credentials',
    up(db) {
      db.exec('CREATE TABLE webhook_tokens(space_id TEXT PRIMARY KEY,hash TEXT NOT NULL)');
    },
  },
  {
    version: 17,
    name: 'ticket pending interval clock',
    up(db) {
      db.exec(`
        ALTER TABLE tickets ADD COLUMN pending_since INTEGER NOT NULL DEFAULT 0;
        UPDATE tickets SET pending_since = updated_at;
      `);
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
