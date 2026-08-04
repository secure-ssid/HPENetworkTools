/**
 * Minimal CSV helpers for authenticated export routes (no secrets/bodies).
 */

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLines(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

export function sendCsv(
  res: { setHeader: (k: string, v: string) => void; send: (b: string) => void },
  filename: string,
  header: string[],
  rows: unknown[][],
): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.send(csvLines(header, rows));
}
