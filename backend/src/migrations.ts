/**
 * Dependency-free migration runner on SQLite's PRAGMA user_version.
 *
 * Forward-only: there are no down migrations — the rollback story is restoring
 * the database file from backup before the upgrade.
 *
 * SQLite caveat: ALTER TABLE ADD COLUMN is cheap, but dropping or altering a
 * column requires the full new-table/copy/rename/drop dance — plan such
 * migrations deliberately.
 *
 * Pattern for derived columns on `subscribers`: ADD COLUMN, then backfill by
 * re-running the fold over `events` — the table is fully recomputable.
 *
 * This module must not import ./db.ts (db.ts calls runMigrations; tests run
 * the chain against in-memory databases).
 */
import type { DatabaseSync } from 'node:sqlite';
import { deriveSubscriber, type StoredEvent } from './derive.ts';

interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

function rederiveAllSubscribers(db: DatabaseSync): void {
  const ids = db
    .prepare('SELECT DISTINCT subscriber_id AS id FROM events WHERE subscriber_id IS NOT NULL')
    .all() as unknown as { id: string }[];
  const selectEvents = db.prepare(
    'SELECT event_type, event_ts, raw FROM events WHERE subscriber_id = ? ORDER BY event_ts',
  );
  const upsert = db.prepare(
    `INSERT INTO subscribers (subscriber_id, status, tier_id, cost_cents, nickname, email, last_event_ts, status_changed_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscriber_id) DO UPDATE SET
       status = excluded.status,
       tier_id = excluded.tier_id,
       cost_cents = excluded.cost_cents,
       nickname = excluded.nickname,
       email = excluded.email,
       last_event_ts = excluded.last_event_ts,
       status_changed_ts = excluded.status_changed_ts`,
  );
  for (const { id } of ids) {
    const events = selectEvents.all(id) as unknown as StoredEvent[];
    const state = deriveSubscriber(events);
    upsert.run(
      id,
      state.status,
      state.tierId,
      state.costCents,
      state.nickname,
      state.email,
      state.lastEventTs,
      state.statusChangedTs,
    );
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'baseline schema (idempotent on pre-migration databases)',
    up(db) {
      db.exec(`
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
    },
  },
  {
    version: 2,
    description: 'subscribers.status_changed_ts + backfill from events',
    up(db) {
      db.exec('ALTER TABLE subscribers ADD COLUMN status_changed_ts INTEGER');
      rederiveAllSubscribers(db);
    },
  },
  {
    version: 3,
    description: 're-derive: subscription-fee payments now initialize status to active',
    up(db) {
      rederiveAllSubscribers(db);
    },
  },
  {
    version: 4,
    description: 'subscribers manual-edit audit columns',
    up(db) {
      db.exec(`
        ALTER TABLE subscribers ADD COLUMN manual_updated_at TEXT;
        ALTER TABLE subscribers ADD COLUMN manual_updated_by INTEGER REFERENCES users(id);
      `);
    },
  },
];

export function runMigrations(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as unknown as {
    user_version: number;
  };
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      console.info(`migration ${migration.version} applied: ${migration.description}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
