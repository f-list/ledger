import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.ts';

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (c) => c.name,
  );
}

const LATEST_VERSION = 3;

describe('runMigrations', () => {
  it('brings a fresh database to the latest version with full schema', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    assert.equal(userVersion(db), LATEST_VERSION);
    for (const table of ['users', 'invites', 'sessions', 'events', 'tiers', 'subscribers']) {
      assert.ok(tableColumns(db, table).length > 0, `table ${table} missing`);
    }
    assert.ok(tableColumns(db, 'subscribers').includes('status_changed_ts'));
  });

  it('is a no-op when already at the latest version', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    runMigrations(db); // would throw on duplicate ALTER TABLE if version tracking failed
    assert.equal(userVersion(db), LATEST_VERSION);
  });

  it('migrates a pre-migration-era database and backfills status_changed_ts', () => {
    const db = new DatabaseSync(':memory:');
    // Simulate a piece-2-era DB: baseline schema at user_version 0 with data.
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY, received_at TEXT NOT NULL, event_type TEXT NOT NULL,
        event_ts INTEGER NOT NULL, subscriber_id TEXT, attempt INTEGER NOT NULL DEFAULT 1,
        raw TEXT NOT NULL, request_id TEXT UNIQUE
      );
      CREATE TABLE subscribers (
        subscriber_id TEXT PRIMARY KEY, status TEXT NOT NULL, tier_id TEXT, cost_cents INTEGER,
        nickname TEXT, email TEXT, flist_account TEXT, notes TEXT, last_event_ts INTEGER,
        seeded INTEGER NOT NULL DEFAULT 0
      );
    `);
    const subscribe = JSON.stringify({
      payload: {
        subscription: { id: 1, tier_id: 5, cost: 299, subscriber_id: 42, cancelled: false, paused: false, billing_failed: false },
        subscriber: { id: 42, nickname: 'Old', email: 'old@example.com' },
      },
      event: 'new_subscription',
      timestamp: 1000,
      request_id: 'a',
    });
    const cancel = JSON.stringify({
      payload: {
        subscription: { id: 1, tier_id: 5, cost: 299, subscriber_id: 42, cancelled: true, paused: false, billing_failed: false },
        subscriber: { id: 42, nickname: 'Old', email: 'old@example.com' },
      },
      event: 'subscription_cancelled',
      timestamp: 2000,
      request_id: 'b',
    });
    db.prepare(
      "INSERT INTO events (received_at, event_type, event_ts, subscriber_id, raw, request_id) VALUES ('x', 'new_subscription', 1000, '42', ?, 'a')",
    ).run(subscribe);
    db.prepare(
      "INSERT INTO events (received_at, event_type, event_ts, subscriber_id, raw, request_id) VALUES ('x', 'subscription_cancelled', 2000, '42', ?, 'b')",
    ).run(cancel);
    // Payment-only subscriber (pre-ledger renewal): migration 3 should mark active.
    const renewal = JSON.stringify({
      payload: {
        payment: { id: 7, amount: 500, subscriber_id: 43, type: 'subscription_fee', tier_id: 6 },
        pledger: { id: 43, nickname: 'Renewer', email: 'r@example.com' },
      },
      event: 'payment_succeed',
      timestamp: 1500,
      request_id: 'c',
    });
    db.prepare(
      "INSERT INTO events (received_at, event_type, event_ts, subscriber_id, raw, request_id) VALUES ('x', 'payment_succeed', 1500, '43', ?, 'c')",
    ).run(renewal);
    // Stale derived row without the new column's data.
    db.prepare(
      "INSERT INTO subscribers (subscriber_id, status, nickname) VALUES ('42', 'active', 'Old')",
    ).run();

    runMigrations(db);

    assert.equal(userVersion(db), LATEST_VERSION);
    const row = db
      .prepare('SELECT status, status_changed_ts, cost_cents FROM subscribers WHERE subscriber_id = ?')
      .get('42') as unknown as { status: string; status_changed_ts: number; cost_cents: number };
    assert.equal(row.status, 'cancelled');
    assert.equal(row.status_changed_ts, 2000);
    assert.equal(row.cost_cents, 299);

    const renewer = db
      .prepare('SELECT status, status_changed_ts, cost_cents FROM subscribers WHERE subscriber_id = ?')
      .get('43') as unknown as { status: string; status_changed_ts: number; cost_cents: number };
    assert.equal(renewer.status, 'active');
    assert.equal(renewer.status_changed_ts, 1500);
    assert.equal(renewer.cost_cents, 500);
  });
});
