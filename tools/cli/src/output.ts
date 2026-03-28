/** Output helpers: human-readable text vs --json mode */

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function printTable(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): void {
  if (rows.length === 0) {
    console.log('(no results)');
    return;
  }

  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = String(row[col] ?? '');
      const current = widths[col];
      if (current === undefined || val.length > current) widths[col] = val.length;
    }
  }

  const getWidth = (col: string): number => widths[col] ?? col.length;
  const sep = columns.map((c) => '-'.repeat(getWidth(c))).join(' | ');
  const header = columns.map((c) => c.padEnd(getWidth(c))).join(' | ');

  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const line = columns.map((c) => String(row[c] ?? '').padEnd(getWidth(c))).join(' | ');
    console.log(line);
  }
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

export function printInfo(message: string): void {
  process.stderr.write(`${message}\n`);
}
