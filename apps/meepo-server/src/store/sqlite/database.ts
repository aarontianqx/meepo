import Database from 'better-sqlite3';

import { runMigrations } from './migrations.js';

/** Opens (or creates) the SQLite database at `path` and brings the schema up to date. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
