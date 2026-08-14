import express from 'express';
import { db } from './db.ts';
import { getTierNameMap } from './tiers-api.ts';

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
}

export const subscribersRouter = express.Router();

subscribersRouter.get('/api/subscribers', (req, res) => {
  const tierNames = getTierNameMap();
  const rows = db
    .prepare(
      `SELECT subscriber_id, status, tier_id, cost_cents, nickname, email,
              flist_account, notes, last_event_ts, status_changed_ts
       FROM subscribers`,
    )
    .all() as unknown as SubscriberRow[];

  res.json({
    subscribers: rows.map((row) => ({
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
    })),
  });
});
