import express from 'express';
import { db } from './db.ts';
import { fetchFlistSubscribed, isFlistCheckConfigured } from './flist-db.ts';
import { getTierNameMap } from './tiers-api.ts';
import { isFlistAccountId, normalizeManualField, validateNumericId } from './validate.ts';

interface SubscriberRow {
  subscriber_id: string;
  status: string;
  tier_id: string | null;
  cost_cents: number | null;
  nickname: string | null;
  email: string | null;
  flist_account: string | null;
  notes: string | null;
  last_event_ts: number | null;
  status_changed_ts: number | null;
  flist_subscribed: number | null;
  flist_checked_at: string | null;
}

const ROW_COLUMNS = `subscriber_id, status, tier_id, cost_cents, nickname, email,
   flist_account, notes, last_event_ts, status_changed_ts, flist_subscribed, flist_checked_at`;

function toApiShape(row: SubscriberRow, tierNames: Map<string, string>) {
  return {
    subscriberId: row.subscriber_id,
    nickname: row.nickname,
    email: row.email,
    status: row.status,
    statusChangedTs: row.status_changed_ts,
    lastEventTs: row.last_event_ts,
    tierId: row.tier_id,
    tierName: row.tier_id === null ? null : (tierNames.get(row.tier_id) ?? null),
    costCents: row.cost_cents,
    flistAccount: row.flist_account,
    notes: row.notes,
    flistSubscribed: row.flist_subscribed,
    flistCheckedAt: row.flist_checked_at,
  };
}

/**
 * Fetch F-List's current subscription flag and cache it on the subscriber row.
 * Shared by the manual POST route and the webhook auto-fetch. Writes only the
 * cache columns — never derived columns or status_changed_ts. No-ops cheaply
 * when the feature is unconfigured or the mapping isn't a numeric account id.
 */
export async function runFlistCheck(
  subscriberId: string,
): Promise<{ ok: true } | { ok: false; code: 400 | 404 | 502 | 503; error: string }> {
  if (!isFlistCheckConfigured()) {
    return { ok: false, code: 503, error: 'F-List lookup is not configured.' };
  }
  const row = db
    .prepare('SELECT flist_account FROM subscribers WHERE subscriber_id = ?')
    .get(subscriberId) as { flist_account: string | null } | undefined;
  if (!row) return { ok: false, code: 404, error: 'No such subscriber.' };
  if (!isFlistAccountId(row.flist_account)) {
    return {
      ok: false,
      code: 400,
      error: 'This subscriber has no numeric F-List account id to check.',
    };
  }
  let subscribed: 0 | 1 | null;
  try {
    subscribed = await fetchFlistSubscribed(row.flist_account);
  } catch (err) {
    console.error(`flist-check: lookup failed for subscriber ${subscriberId}:`, err);
    return { ok: false, code: 502, error: 'F-List lookup failed.' };
  }
  db.prepare(
    'UPDATE subscribers SET flist_subscribed = ?, flist_checked_at = ? WHERE subscriber_id = ?',
  ).run(subscribed, new Date().toISOString(), subscriberId);
  return { ok: true };
}

export const subscribersRouter = express.Router();

subscribersRouter.get('/api/subscribers', (req, res) => {
  const tierNames = getTierNameMap();
  const rows = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM subscribers`)
    .all() as unknown as SubscriberRow[];
  res.json({
    subscribers: rows.map((row) => toApiShape(row, tierNames)),
    flistCheckConfigured: isFlistCheckConfigured(),
  });
});

subscribersRouter.post('/api/subscribers/:subscriberId/flist-check', (req, res) => {
  const subscriberId = req.params.subscriberId;
  if (!validateNumericId(subscriberId)) {
    res.status(400).json({ error: 'Invalid subscriber id.' });
    return;
  }
  void runFlistCheck(subscriberId).then((result) => {
    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }
    const row = db
      .prepare(`SELECT ${ROW_COLUMNS} FROM subscribers WHERE subscriber_id = ?`)
      .get(subscriberId) as unknown as SubscriberRow;
    res.json(toApiShape(row, getTierNameMap()));
  });
});

subscribersRouter.patch('/api/subscribers/:subscriberId', (req, res) => {
  const subscriberId = req.params.subscriberId;
  if (!validateNumericId(subscriberId)) {
    res.status(400).json({ error: 'Invalid subscriber id.' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const flistAccount = normalizeManualField(body.flistAccount, 100);
  const notes = normalizeManualField(body.notes, 1000);
  const nickname = normalizeManualField(body.nickname, 100);
  if (!flistAccount.ok) {
    res.status(400).json({ error: 'flistAccount must be a string of at most 100 characters.' });
    return;
  }
  if (!notes.ok) {
    res.status(400).json({ error: 'notes must be a string of at most 1000 characters.' });
    return;
  }
  if (!nickname.ok) {
    res.status(400).json({ error: 'nickname must be a string of at most 100 characters.' });
    return;
  }
  if (flistAccount.absent && notes.absent && nickname.absent) {
    res.status(400).json({ error: 'Provide flistAccount, notes, and/or nickname.' });
    return;
  }

  const exists = db.prepare('SELECT 1 FROM subscribers WHERE subscriber_id = ?').get(subscriberId);
  if (!exists) {
    res.status(404).json({ error: 'No such subscriber.' });
    return;
  }

  const sets: string[] = ['manual_updated_at = ?', 'manual_updated_by = ?'];
  const params: (string | number | null)[] = [new Date().toISOString(), req.user?.id ?? null];
  if (!flistAccount.absent) {
    sets.push('flist_account = ?');
    params.push(flistAccount.value);
  }
  if (!notes.absent) {
    sets.push('notes = ?');
    params.push(notes.value);
  }
  if (!nickname.absent) {
    // Unlike the manual columns above, `nickname` is derived: the next webhook
    // event for this subscriber re-derives it from the payload. Intentional —
    // this is a stopgap correction for stale names, not a persistent override.
    sets.push('nickname = ?');
    params.push(nickname.value);
  }
  db.prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE subscriber_id = ?`).run(
    ...params,
    subscriberId,
  );

  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM subscribers WHERE subscriber_id = ?`)
    .get(subscriberId) as unknown as SubscriberRow;
  res.json(toApiShape(row, getTierNameMap()));
});
