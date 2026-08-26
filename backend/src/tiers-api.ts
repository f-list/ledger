import express from 'express';
import { db } from './db.ts';
import { extractDisplayFields } from './derive.ts';
import { validateNumericId, validateTierName } from './validate.ts';

interface TierRow {
  tier_id: string;
  name: string;
}

/** tier_id → staff-assigned name, for attaching tierName to API rows. */
export function getTierNameMap(): Map<string, string> {
  return new Map(
    (db.prepare('SELECT tier_id, name FROM tiers').all() as unknown as TierRow[]).map((t) => [
      t.tier_id,
      t.name,
    ]),
  );
}

export const tiersRouter = express.Router();

tiersRouter.get('/api/tiers', (req, res) => {
  // Tier ids live inside events' raw JSON, not a column; a full scan is
  // milliseconds at this scale (hundreds of events).
  const seen = new Map<string, number>();
  for (const row of db.prepare('SELECT raw FROM events').all() as unknown as { raw: string }[]) {
    const tierId = extractDisplayFields(row.raw).tierId;
    if (tierId) seen.set(tierId, (seen.get(tierId) ?? 0) + 1);
  }
  for (const row of db
    .prepare('SELECT DISTINCT tier_id FROM subscribers WHERE tier_id IS NOT NULL')
    .all() as unknown as { tier_id: string }[]) {
    if (!seen.has(row.tier_id)) seen.set(row.tier_id, 0);
  }

  const names = new Map<string, string>();
  for (const row of db.prepare('SELECT tier_id, name FROM tiers').all() as unknown as TierRow[]) {
    names.set(row.tier_id, row.name);
    // Named-but-never-seen tiers stay listed so they remain editable.
    if (!seen.has(row.tier_id)) seen.set(row.tier_id, 0);
  }

  const tiers = [...seen.entries()]
    .map(([tierId, seenCount]) => ({ tierId, name: names.get(tierId) ?? null, seenCount }))
    .sort((a, b) => b.seenCount - a.seenCount || a.tierId.localeCompare(b.tierId));

  res.json({ tiers });
});

tiersRouter.put('/api/tiers/:tierId', (req, res) => {
  const tierId = req.params.tierId;
  if (!validateNumericId(tierId)) {
    res.status(400).json({ error: 'Invalid tier id.' });
    return;
  }

  const name: unknown = (req.body as Record<string, unknown> | undefined)?.name;
  if (typeof name === 'string' && name.trim() === '') {
    db.prepare('DELETE FROM tiers WHERE tier_id = ?').run(tierId);
    res.json({ deleted: true });
    return;
  }
  if (!validateTierName(name)) {
    res.status(400).json({ error: 'Name must be 1-64 characters.' });
    return;
  }

  const trimmed = name.trim();
  db.prepare(
    `INSERT INTO tiers (tier_id, name, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(tier_id) DO UPDATE SET
       name = excluded.name, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(tierId, trimmed, new Date().toISOString(), req.user?.id ?? null);
  res.json({ tierId, name: trimmed });
});
