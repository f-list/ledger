import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv, rowsToObjects } from './csv.ts';

describe('parseCsv', () => {
  it('parses plain rows', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted commas and escaped quotes', () => {
    assert.deepEqual(parseCsv('name,notes\n"Doe, John","said ""hi"""\n'), [
      ['name', 'notes'],
      ['Doe, John', 'said "hi"'],
    ]);
  });

  it('handles CRLF line endings', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles unicode and no trailing newline', () => {
    assert.deepEqual(parseCsv('name\n☮DaChief'), [['name'], ['☮DaChief']]);
  });

  it('preserves empty fields', () => {
    assert.deepEqual(parseCsv('a,,c\n,,\n'), [
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });
});

describe('rowsToObjects', () => {
  it('maps rows to header-keyed records', () => {
    const { records, ragged } = rowsToObjects([
      ['id', 'name'],
      ['1', 'one'],
      ['2', 'two'],
    ]);
    assert.deepEqual(records, [
      { id: '1', name: 'one' },
      { id: '2', name: 'two' },
    ]);
    assert.equal(ragged.length, 0);
  });

  it('collects ragged rows with line numbers instead of guessing', () => {
    const { records, ragged } = rowsToObjects([
      ['id', 'name'],
      ['1'],
      ['2', 'two'],
    ]);
    assert.equal(records.length, 1);
    assert.deepEqual(ragged, [{ line: 2, row: ['1'] }]);
  });
});
