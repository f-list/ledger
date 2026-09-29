import pg from 'pg';
import { config } from './config.ts';

// The ONLY module coupled to F-List's Postgres schema. Everything F-List-side
// lives here so a schema drift has exactly one place to fix.

let pool: pg.Pool | null = null;

export function isFlistCheckConfigured(): boolean {
  return !!config.flistDbUrl;
}

function getPool(): pg.Pool | null {
  if (!config.flistDbUrl) return null;
  if (pool === null) {
    pool = new pg.Pool({
      connectionString: config.flistDbUrl,
      max: 2,
      // Fail fast: a slow F-List DB or a dropped SSH tunnel must surface as an
      // error quickly, never a hung request (and never the webhook ack path).
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 5000,
      idleTimeoutMillis: 30000,
    });
    // A pool-level error (e.g. an idle client dropped by a tunnel restart) must
    // not crash the process; the next query re-establishes a connection.
    pool.on('error', (err) => console.error('flist-db: idle client error:', err));
  }
  return pool;
}

/**
 * Map F-List's `account.subscribed` (`fakebool_enum`, returned by pg as '0'/'1')
 * to our tri-state cache: 1 = subscribed, 0 = not, null = unknown.
 */
export function mapSubscribed(raw: unknown): 0 | 1 | null {
  if (raw === '1' || raw === 1) return 1;
  if (raw === '0' || raw === 0) return 0;
  return null;
}

/**
 * Read the current F-List subscription flag for an account id. Returns null when
 * the account id is not found on F-List (a real answer, distinct from an error).
 * Throws on connection/query failure — the caller maps that to a 502 and keeps
 * the previously cached value.
 */
export async function fetchFlistSubscribed(accountId: string): Promise<0 | 1 | null> {
  const activePool = getPool();
  if (activePool === null) throw new Error('F-List lookup is not configured.');
  const result = await activePool.query<{ subscribed: string | null }>(
    'SELECT subscribed FROM account WHERE account_id = $1',
    [accountId],
  );
  if (result.rows.length === 0) return null;
  return mapSubscribed(result.rows[0].subscribed);
}
