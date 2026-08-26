/**
 * Pure decision logic for the workbook CSV import (docs/7-csv-import.md).
 * No I/O — the CLI shell (import-csv.ts) feeds it parsed records and DB state.
 */
import { validateNumericId } from './validate.ts';

export interface WorkbookRow {
  subscriberId: string;
  flistAccount: string | null; // from flist_account_id
  notes: string | null;
  nickname: string | null; // subscribestar_username
  tierTitle: string | null;
  costCents: number | null;
}

export interface SkippedRow {
  line: number;
  reason: string;
  detail: string;
}

export function parseMoney(value: string): number | null {
  const match = /^\$(\d+)\.(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

export function parseWorkbookRow(
  record: Record<string, string>,
  line: number,
): { row: WorkbookRow } | { skip: SkippedRow } {
  const subscriberId = clean(record.subscribestar_id);
  if (subscriberId === null) {
    return {
      skip: {
        line,
        reason: 'no subscribestar_id',
        detail: `flist=${clean(record.flist_account_id) ?? '-'} name=${clean(record.subscribestar_username) ?? '-'}`,
      },
    };
  }
  if (!validateNumericId(subscriberId)) {
    return { skip: { line, reason: 'malformed subscribestar_id', detail: subscriberId } };
  }

  const flistAccount = clean(record.flist_account_id);
  if (flistAccount !== null && !validateNumericId(flistAccount)) {
    return { skip: { line, reason: 'malformed flist_account_id', detail: `${subscriberId}: ${record.flist_account_id}` } };
  }

  const cost = clean(record.monthly_tier);
  return {
    row: {
      subscriberId,
      flistAccount,
      notes: clean(record.notes),
      nickname: clean(record.subscribestar_username),
      tierTitle: clean(record.tier_title),
      costCents: cost === null ? null : parseMoney(cost),
    },
  };
}

export interface ConflictGroup {
  subscriberId: string;
  reason: string;
  rows: WorkbookRow[];
}

/**
 * Collapse duplicate subscriber ids. The only auto-mergeable pattern (seen live
 * as renamed subscribers): exactly one row carries the F-List mapping — take
 * mapping + notes from it, everything else from the other row. Anything else
 * is a conflict for a human.
 */
export function resolveDuplicates(rows: WorkbookRow[]): {
  resolved: WorkbookRow[];
  conflicts: ConflictGroup[];
} {
  const byId = new Map<string, WorkbookRow[]>();
  for (const row of rows) {
    const group = byId.get(row.subscriberId);
    if (group) group.push(row);
    else byId.set(row.subscriberId, [row]);
  }

  const resolved: WorkbookRow[] = [];
  const conflicts: ConflictGroup[] = [];
  for (const [subscriberId, group] of byId) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }
    const mapped = group.filter((r) => r.flistAccount !== null);
    if (group.length === 2 && mapped.length === 1) {
      const matched = mapped[0];
      const other = group.find((r) => r !== matched)!;
      resolved.push({
        ...other,
        flistAccount: matched.flistAccount,
        notes: other.notes ?? matched.notes,
        // Prefer the row that knows the tier (the fresher export row).
        tierTitle: other.tierTitle ?? matched.tierTitle,
        costCents: other.costCents ?? matched.costCents,
      });
    } else {
      conflicts.push({
        subscriberId,
        reason:
          mapped.length > 1 ? 'multiple rows with different F-List mappings' : 'unmergeable duplicate rows',
        rows: group,
      });
    }
  }
  return { resolved, conflicts };
}

export interface ExistingSubscriber {
  flistAccount: string | null;
  notes: string | null;
}

export interface UpdateAction {
  subscriberId: string;
  fields: Partial<{ flistAccount: string; notes: string }>;
}

/**
 * Seeded rows get status "imported" — a value derivation never produces. It
 * survives only until the subscriber's first webhook event; the visible
 * imported→active transitions as renewals arrive are the confirmation signal
 * (still-imported after a full billing cycle = lapsed candidate). No
 * status_changed_ts until a real event provides one.
 */
export interface SeededInsert {
  subscriberId: string;
  nickname: string | null;
  tierId: string | null;
  costCents: number | null;
  flistAccount: string | null;
  notes: string | null;
}

export interface ImportReport {
  totalRows: number;
  skipped: SkippedRow[];
  conflictGroups: ConflictGroup[];
  mergedDuplicates: number;
  updates: number;
  inserts: number;
  noops: number;
  fieldConflicts: { subscriberId: string; field: string; existing: string; csv: string }[];
  unknownTierTitles: Map<string, number>;
}

export interface ImportPlan {
  updates: UpdateAction[];
  inserts: SeededInsert[];
  report: ImportReport;
}

export function buildImportPlan(
  records: Record<string, string>[],
  existing: Map<string, ExistingSubscriber>,
  tierIdByName: Map<string, string>,
): ImportPlan {
  const skipped: SkippedRow[] = [];
  const parsed: WorkbookRow[] = [];
  records.forEach((record, index) => {
    const result = parseWorkbookRow(record, index + 2);
    if ('skip' in result) skipped.push(result.skip);
    else parsed.push(result.row);
  });

  const { resolved, conflicts } = resolveDuplicates(parsed);
  const mergedDuplicates = parsed.length - resolved.length - conflicts.reduce((n, c) => n + c.rows.length, 0);

  const updates: UpdateAction[] = [];
  const inserts: SeededInsert[] = [];
  const fieldConflicts: ImportReport['fieldConflicts'] = [];
  const unknownTierTitles = new Map<string, number>();
  let noops = 0;

  for (const row of resolved) {
    const current = existing.get(row.subscriberId);
    if (current) {
      const fields: UpdateAction['fields'] = {};
      for (const field of ['flistAccount', 'notes'] as const) {
        const csvValue = row[field];
        if (csvValue === null) continue;
        const dbValue = current[field];
        if (dbValue === null) fields[field] = csvValue;
        else if (dbValue !== csvValue) {
          fieldConflicts.push({ subscriberId: row.subscriberId, field, existing: dbValue, csv: csvValue });
        }
      }
      if (Object.keys(fields).length > 0) updates.push({ subscriberId: row.subscriberId, fields });
      else noops++;
      continue;
    }

    let tierId: string | null = null;
    if (row.tierTitle !== null) {
      tierId = tierIdByName.get(row.tierTitle) ?? null;
      if (tierId === null) {
        unknownTierTitles.set(row.tierTitle, (unknownTierTitles.get(row.tierTitle) ?? 0) + 1);
      }
    }
    inserts.push({
      subscriberId: row.subscriberId,
      nickname: row.nickname,
      tierId,
      costCents: row.costCents,
      flistAccount: row.flistAccount,
      notes: row.notes,
    });
  }

  return {
    updates,
    inserts,
    report: {
      totalRows: records.length,
      skipped,
      conflictGroups: conflicts,
      mergedDuplicates,
      updates: updates.length,
      inserts: inserts.length,
      noops,
      fieldConflicts,
      unknownTierTitles,
    },
  };
}

export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`rows: ${report.totalRows}`);
  lines.push(
    `plan: ${report.inserts} seeded inserts, ${report.updates} manual-column updates, ${report.noops} already-covered no-ops, ${report.mergedDuplicates} duplicate pairs auto-merged`,
  );

  if (report.skipped.length > 0) {
    lines.push(`\nskipped rows (${report.skipped.length}):`);
    for (const skip of report.skipped) lines.push(`  line ${skip.line}: ${skip.reason} (${skip.detail})`);
  }
  if (report.conflictGroups.length > 0) {
    lines.push(`\nconflict groups needing human resolution (${report.conflictGroups.length}):`);
    for (const group of report.conflictGroups) {
      lines.push(`  subscriber ${group.subscriberId}: ${group.reason}`);
      for (const row of group.rows) {
        lines.push(`    name=${row.nickname ?? '-'} flist=${row.flistAccount ?? '-'} tier=${row.tierTitle ?? '-'}`);
      }
    }
  }
  if (report.fieldConflicts.length > 0) {
    lines.push(`\nCSV disagrees with existing DB values (kept DB, ${report.fieldConflicts.length}):`);
    for (const conflict of report.fieldConflicts) {
      lines.push(`  ${conflict.subscriberId}.${conflict.field}: db="${conflict.existing}" csv="${conflict.csv}"`);
    }
  }
  if (report.unknownTierTitles.size > 0) {
    lines.push(`\ntier titles not found in the tiers table (left null):`);
    for (const [title, count] of report.unknownTierTitles) lines.push(`  "${title}" × ${count}`);
  }
  return lines.join('\n');
}
