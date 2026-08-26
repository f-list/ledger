import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildImportPlan,
  parseMoney,
  parseWorkbookRow,
  resolveDuplicates,
  type WorkbookRow,
} from './import-core.ts';

// Sanitized fixtures — same shape as the real workbook, fake people.
function record(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    status: 'ACTIVE',
    flist_account_id: '111111',
    flist_link: 'ignored',
    subscribestar_username: 'TestUser',
    subscribestar_id: '222222',
    subscribestar_link: 'ignored',
    tier_title: 'Basic',
    monthly_tier: '$2.99',
    subscribed_since: '2025-06-15',
    flist_grant_state: 'ignored',
    latest_grant_expiry: 'ignored',
    days_to_expiry: '',
    grant_types: 'ignored',
    match: 'matched',
    verified_inactive: '',
    notes: 'a note',
    ...overrides,
  };
}

function row(overrides: Partial<WorkbookRow> = {}): WorkbookRow {
  return {
    subscriberId: '222222',
    flistAccount: '111111',
    notes: null,
    nickname: 'TestUser',
    tierTitle: 'Basic',
    costCents: 299,
    ...overrides,
  };
}

describe('parseMoney', () => {
  it('parses dollars to cents', () => {
    assert.equal(parseMoney('$2.99'), 299);
    assert.equal(parseMoney('$20.00'), 2000);
    assert.equal(parseMoney('2.99'), null);
    assert.equal(parseMoney('$2.9'), null);
  });
});

describe('parseWorkbookRow', () => {
  it('extracts the used columns (status and subscribed_since are ignored)', () => {
    const result = parseWorkbookRow(record(), 2);
    assert.ok('row' in result);
    assert.deepEqual(result.row, {
      subscriberId: '222222',
      flistAccount: '111111',
      notes: 'a note',
      nickname: 'TestUser',
      tierTitle: 'Basic',
      costCents: 299,
    });
  });

  it('skips rows without a subscribestar id', () => {
    const result = parseWorkbookRow(record({ subscribestar_id: '' }), 5);
    assert.ok('skip' in result);
    assert.equal(result.skip.line, 5);
    assert.equal(result.skip.reason, 'no subscribestar_id');
  });

  it('tolerates blank optional columns', () => {
    const result = parseWorkbookRow(record({ tier_title: '', monthly_tier: '', notes: '' }), 2);
    assert.ok('row' in result);
    assert.equal(result.row.tierTitle, null);
    assert.equal(result.row.costCents, null);
    assert.equal(result.row.notes, null);
  });
});

describe('resolveDuplicates', () => {
  it('passes unique rows through', () => {
    const { resolved, conflicts } = resolveDuplicates([row(), row({ subscriberId: '333333' })]);
    assert.equal(resolved.length, 2);
    assert.equal(conflicts.length, 0);
  });

  it('auto-merges the renamed-subscriber pattern', () => {
    // Old matched row: mapping + notes, no tier. Fresh row: tier, no mapping.
    const matched = row({ flistAccount: '111111', notes: 'old note', tierTitle: null, costCents: null, nickname: 'OldName' });
    const fresh = row({ flistAccount: null, notes: null, tierTitle: 'Basic', costCents: 299, nickname: 'NewName' });
    const { resolved, conflicts } = resolveDuplicates([matched, fresh]);
    assert.equal(conflicts.length, 0);
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0], {
      subscriberId: '222222',
      flistAccount: '111111',
      notes: 'old note',
      nickname: 'NewName',
      tierTitle: 'Basic',
      costCents: 299,
    });
  });

  it('flags conflicting mappings as a whole-group conflict', () => {
    const { resolved, conflicts } = resolveDuplicates([
      row({ flistAccount: '111111' }),
      row({ flistAccount: '999999' }),
    ]);
    assert.equal(resolved.length, 0);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].reason, 'multiple rows with different F-List mappings');
  });

  it('flags unmapped duplicate pairs as conflicts', () => {
    const { resolved, conflicts } = resolveDuplicates([
      row({ flistAccount: null, nickname: 'PersonA' }),
      row({ flistAccount: null, nickname: 'PersonB' }),
    ]);
    assert.equal(resolved.length, 0);
    assert.equal(conflicts.length, 1);
  });
});

describe('buildImportPlan', () => {
  const tiers = new Map([['Basic', '101735']]);

  it('creates seeded inserts for unseen subscribers', () => {
    const plan = buildImportPlan([record()], new Map(), tiers);
    assert.equal(plan.inserts.length, 1);
    assert.deepEqual(plan.inserts[0], {
      subscriberId: '222222',
      nickname: 'TestUser',
      tierId: '101735',
      costCents: 299,
      flistAccount: '111111',
      notes: 'a note',
    });
    assert.equal(plan.updates.length, 0);
  });

  it('fill-only updates existing subscribers and reports disagreements', () => {
    const existing = new Map([
      ['222222', { flistAccount: null, notes: 'staff-written' }],
    ]);
    const plan = buildImportPlan([record({ notes: 'csv note' })], existing, tiers);
    assert.equal(plan.inserts.length, 0);
    assert.deepEqual(plan.updates, [{ subscriberId: '222222', fields: { flistAccount: '111111' } }]);
    assert.deepEqual(plan.report.fieldConflicts, [
      { subscriberId: '222222', field: 'notes', existing: 'staff-written', csv: 'csv note' },
    ]);
  });

  it('is idempotent: a post-apply state yields zero actions', () => {
    const existing = new Map([
      ['222222', { flistAccount: '111111', notes: 'a note' }],
    ]);
    const plan = buildImportPlan([record()], existing, tiers);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.inserts.length, 0);
    assert.equal(plan.report.noops, 1);
  });

  it('reports unknown tier titles and leaves tier null', () => {
    const plan = buildImportPlan([record({ tier_title: 'Mystery Tier' })], new Map(), tiers);
    assert.equal(plan.inserts[0].tierId, null);
    assert.deepEqual([...plan.report.unknownTierTitles], [['Mystery Tier', 1]]);
  });

  it('counts skips and conflicts in the report', () => {
    const plan = buildImportPlan(
      [
        record({ subscribestar_id: '' }),
        record({ subscribestar_id: '444444', flist_account_id: '111111' }),
        record({ subscribestar_id: '444444', flist_account_id: '999999' }),
      ],
      new Map(),
      tiers,
    );
    assert.equal(plan.report.skipped.length, 1);
    assert.equal(plan.report.conflictGroups.length, 1);
    assert.equal(plan.inserts.length, 0);
  });
});
