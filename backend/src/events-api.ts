import express from 'express';
import { db } from './db.ts';
import { extractDisplayFields } from './derive.ts';

const PAGE_LIMIT = 100;

const selectPage = db.prepare(
  `SELECT id, received_at, event_type, event_ts, subscriber_id, raw
   FROM events
   WHERE (:before IS NULL OR id < :before)
   ORDER BY id DESC
   LIMIT :limit`,
);

interface EventRow {
  id: number;
  received_at: string;
  event_type: string;
  event_ts: number;
  subscriber_id: string | null;
  raw: string;
}

/** Parses a positive-integer query param; undefined when absent, null when malformed. */
function positiveIntParam(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export const eventsRouter = express.Router();

eventsRouter.get('/api/events', (req, res) => {
  const before = positiveIntParam(req.query.before);
  const limit = positiveIntParam(req.query.limit);
  if (before === null || limit === null) {
    res.status(400).json({ error: 'before and limit must be positive integers.' });
    return;
  }

  const pageSize = Math.min(limit ?? PAGE_LIMIT, PAGE_LIMIT);
  const rows = selectPage.all({ before: before ?? null, limit: pageSize }) as unknown as EventRow[];

  const tierNames = new Map(
    (db.prepare('SELECT tier_id, name FROM tiers').all() as unknown as { tier_id: string; name: string }[]).map(
      (t) => [t.tier_id, t.name],
    ),
  );

  const events = rows.map((row) => {
    const display = extractDisplayFields(row.raw);
    return {
      id: row.id,
      receivedAt: row.received_at,
      eventType: row.event_type,
      eventTs: row.event_ts,
      subscriberId: row.subscriber_id,
      nickname: display.nickname,
      tierId: display.tierId,
      tierName: display.tierId === null ? null : (tierNames.get(display.tierId) ?? null),
      costCents: display.costCents,
    };
  });

  res.json({
    events,
    nextBefore: rows.length === pageSize && rows.length > 0 ? rows[rows.length - 1].id : null,
  });
});
