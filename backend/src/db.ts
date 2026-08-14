import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    invited_by    INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    id            INTEGER PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    created_by    INTEGER REFERENCES users(id),
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    used_by       INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
