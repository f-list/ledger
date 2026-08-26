/**
 * Workbook CSV import CLI (docs/7-csv-import.md).
 *
 *   node src/import-csv.ts <file.csv> [--apply]
 *
 * Dry-run by default: prints the full plan/report without touching the
 * database. --apply commits everything in a single transaction.
 */
import { readFileSync } from 'node:fs';
import { parseCsv, rowsToObjects } from './csv.ts';
import { buildImportPlan, formatReport, type ExistingSubscriber } from './import-core.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('usage: node src/import-csv.ts <file.csv> [--apply]');
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`cannot read ${file}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

const { records, ragged } = rowsToObjects(parseCsv(text));
if (records.length === 0) {
  console.error('no data rows parsed — is this the right file?');
  process.exit(1);
}
for (const bad of ragged) {
  console.warn(`warning: line ${bad.line} has ${bad.row.length} fields, expected header width — skipped`);
}

// Importing db.ts opens the database and runs migrations.
const { db } = await import('./db.ts');

const existing = new Map<string, ExistingSubscriber>(
  (
    db.prepare('SELECT subscriber_id, flist_account, notes FROM subscribers').all() as unknown as {
      subscriber_id: string;
      flist_account: string | null;
      notes: string | null;
    }[]
  ).map((row) => [row.subscriber_id, { flistAccount: row.flist_account, notes: row.notes }]),
);

const tierIdByName = new Map<string, string>(
  (db.prepare('SELECT tier_id, name FROM tiers').all() as unknown as { tier_id: string; name: string }[]).map(
    (t) => [t.name, t.tier_id],
  ),
);

const plan = buildImportPlan(records, existing, tierIdByName);
console.log(formatReport(plan.report));

if (!apply) {
  console.log('\ndry run — nothing written. Re-run with --apply to commit.');
  process.exit(0);
}

const now = new Date().toISOString();
const updateStmts = {
  flistAccount: db.prepare(
    'UPDATE subscribers SET flist_account = ?, manual_updated_at = ?, manual_updated_by = NULL WHERE subscriber_id = ?',
  ),
  notes: db.prepare(
    'UPDATE subscribers SET notes = ?, manual_updated_at = ?, manual_updated_by = NULL WHERE subscriber_id = ?',
  ),
};
// Seeded rows get status "imported" (never produced by derivation) and no
// status_changed_ts — the first real webhook event supplies both, making the
// imported→active transition visible as renewals confirm subscribers.
const insertStmt = db.prepare(
  `INSERT INTO subscribers
     (subscriber_id, status, tier_id, cost_cents, nickname, email, flist_account, notes,
      last_event_ts, status_changed_ts, seeded, manual_updated_at, manual_updated_by)
   VALUES (?, 'imported', ?, ?, ?, NULL, ?, ?, NULL, NULL, 1, ?, NULL)`,
);

db.exec('BEGIN');
try {
  for (const update of plan.updates) {
    if (update.fields.flistAccount !== undefined) {
      updateStmts.flistAccount.run(update.fields.flistAccount, now, update.subscriberId);
    }
    if (update.fields.notes !== undefined) {
      updateStmts.notes.run(update.fields.notes, now, update.subscriberId);
    }
  }
  for (const insert of plan.inserts) {
    insertStmt.run(
      insert.subscriberId,
      insert.tierId,
      insert.costCents,
      insert.nickname,
      insert.flistAccount,
      insert.notes,
      insert.flistAccount !== null || insert.notes !== null ? now : null,
    );
  }
  db.exec('COMMIT');
  console.log(`\napplied: ${plan.inserts.length} inserts, ${plan.updates.length} updates.`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('\nimport failed, rolled back:', err);
  process.exit(1);
}
