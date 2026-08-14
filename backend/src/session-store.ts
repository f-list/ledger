import session from 'express-session';
import { db } from './db.ts';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const selectStmt = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
const upsertStmt = db.prepare(
  `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
   ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
);
const touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
const deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const purgeStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

function expiryOf(sessionData: session.SessionData): number {
  const expires = sessionData.cookie?.expires;
  if (expires) return new Date(expires).getTime();
  return Date.now() + DEFAULT_TTL_MS;
}

export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    purgeStmt.run(Date.now());
    setInterval(() => purgeStmt.run(Date.now()), 60 * 60 * 1000).unref();
  }

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    try {
      const row = selectStmt.get(sid) as { data: string; expires_at: number } | undefined;
      if (!row || row.expires_at < Date.now()) {
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.data) as session.SessionData);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      upsertStmt.run(sid, JSON.stringify(sessionData), expiryOf(sessionData));
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      touchStmt.run(expiryOf(sessionData), sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      deleteStmt.run(sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }
}
