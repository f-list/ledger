import express from 'express';
import { db } from './db.ts';
import { getTierNameMap } from './tiers-api.ts';
import { normalizeManualField, validateNumericId } from './validate.ts';

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

const ROW_COLUMNS = `subscriber_id, status, tier_id, cost_cents, nickname, email,
   flist_account, notes, last_event_ts, status_changed_ts`;

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
  };
}

export const subscribersRouter = express.Router();

subscribersRouter.get('/api/subscribers', (req, res) => {
  const tierNames = getTierNameMap();
  const rows = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM subscribers`)
    .all() as unknown as SubscriberRow[];
  res.json({ subscribers: rows.map((row) => toApiShape(row, tierNames)) });
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
  if (!flistAccount.ok) {
    res.status(400).json({ error: 'flistAccount must be a string of at most 100 characters.' });
    return;
  }
  if (!notes.ok) {
    res.status(400).json({ error: 'notes must be a string of at most 1000 characters.' });
    return;
  }
  if (flistAccount.absent && notes.absent) {
    res.status(400).json({ error: 'Provide flistAccount and/or notes.' });
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
  db.prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE subscriber_id = ?`).run(
    ...params,
    subscriberId,
  );

  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM subscribers WHERE subscriber_id = ?`)
    .get(subscriberId) as unknown as SubscriberRow;
  res.json(toApiShape(row, getTierNameMap()));
});
