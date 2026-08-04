/**
 * Download a server-generated CSV via the shared API layer.
 *
 * Used when the operator wants the portal's authoritative export (full queue /
 * filter applied server-side) rather than the client table snapshot.
 * Never logs response bodies — only status/filename/error strings.
 */

import { apiFetch } from '../api/core';

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* keep fallback path */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain?.[1]) return plain[1].trim();
  return fallback;
}

/**
 * GET `path` as a blob and trigger a browser download.
 * Returns `{ ok: false, error }` on network/HTTP failure without throwing.
 */
export async function downloadApiCsv(
  path: string,
  fallbackName: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await apiFetch(path);
    if (!r.ok) {
      // Do not read/log the body — status is enough for the toast.
      return { ok: false, error: `Server export failed (HTTP ${r.status})` };
    }
    const blob = await r.blob();
    const name = filenameFromDisposition(r.headers.get('content-disposition'), fallbackName);
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Server export failed',
    };
  }
}
