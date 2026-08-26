/** Minimal RFC-4180-subset CSV parser. Pure; no imports. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

/**
 * Map data rows to objects keyed by the header row. Rows whose length differs
 * from the header's are collected separately (ragged rows) rather than guessed at.
 */
export function rowsToObjects(rows: string[][]): {
  records: Record<string, string>[];
  ragged: { line: number; row: string[] }[];
} {
  const [header, ...dataRows] = rows;
  const records: Record<string, string>[] = [];
  const ragged: { line: number; row: string[] }[] = [];
  if (!header) return { records, ragged };

  dataRows.forEach((row, index) => {
    if (row.length !== header.length) {
      ragged.push({ line: index + 2, row });
      return;
    }
    records.push(Object.fromEntries(header.map((name, i) => [name, row[i]])));
  });
  return { records, ragged };
}
