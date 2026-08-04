/**
 * Client-side CSV helpers. There is no reporting backend — exports are the
 * rows the operator is looking at right now, never a fabricated async job.
 */

export function csvEscape(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function rowsToCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const head = headers.map(csvEscape).join(',');
  const body = rows.map((row) => row.map(csvEscape).join(','));
  return [head, ...body].join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportTableCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>,
): number {
  downloadCsv(filename, rowsToCsv(headers, rows));
  return rows.length;
}
