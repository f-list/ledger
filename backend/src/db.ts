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

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY,
    received_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    event_ts      INTEGER NOT NULL,
    subscriber_id TEXT,
    attempt       INTEGER NOT NULL DEFAULT 1,
    raw           TEXT NOT NULL,
    request_id    TEXT UNIQUE
  );

  CREATE INDEX IF NOT EXISTS idx_events_subscriber ON events(subscriber_id, event_ts);

  CREATE TABLE IF NOT EXISTS tiers (
    tier_id     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    subscriber_id   TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    tier_id         TEXT,
    cost_cents      INTEGER,
    nickname        TEXT,
    email           TEXT,
    flist_account   TEXT,
    notes           TEXT,
    last_event_ts   INTEGER,
    seeded          INTEGER NOT NULL DEFAULT 0
  );
`);
