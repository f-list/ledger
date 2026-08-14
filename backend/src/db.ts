import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { runMigrations } from './migrations.ts';

mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

// Schema lives in migrations.ts (PRAGMA user_version runner, forward-only).
runMigrations(db);
