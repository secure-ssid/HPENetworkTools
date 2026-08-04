/**
 * Minimal CSV helpers for authenticated export routes (no secrets/bodies).
 *
 * Defense in depth: every cell passes through `redactExportCell` before escape
 * so a free-text field that accidentally embeds URL userinfo,
 * password/token assignments, cookie headers, or PEM blocks cannot leave the
 * process in a download.
 */

/** Credential-bearing URL userinfo (`//user:pass@host`). */
const URL_USERINFO = /\/\/([^/\s@]*?):([^/\s@]*?)@/g;

/** `Authorization: Bearer …` and bare `Bearer …` tokens. */
const BEARER_AUTH = /\bauthorization\s*[:=]\s*bearer\s+\S+/gi;
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._+/=-]+/gi;

/**
 * Obvious secret assignments in free text / error strings.
 * Requires `:` or `=` so bare words like device name "token-sw-01" stay intact.
 */
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi;

/**
 * Cookie / Set-Cookie header material that can leak session ids if pasted
 * into free-text error/note fields (Loop 103/105). Bare word "cookie" stays.
 */
const COOKIE_HEADER = /\bset-cookie\s*[:=]\s*[^\r\n]+/gi;
const COOKIE_PAIR = /\bcookie\s*[:=]\s*[^\r\n;]+(?:;\s*[^\r\n;]+)*/gi;

/**
 * `Authorization: Basic <token>` always redacts (Loop 105). Bare `Basic <b64>`
 * only when the token is long enough (≥16 base64 chars) or `=`-padded — so
 * phrases like "basic connectivity" stay intact.
 */
const BASIC_AUTH_HEADER = /\bauthorization\s*[:=]\s*basic\s+\S+/gi;
const BASIC_BARE = /\bbasic\s+[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/gi;

/**
 * Compact JWT-looking tokens (three base64url segments, header starts `eyJ`).
 * Distinctive enough that inventory names are not collapsed (Loop 105).
 */
const JWT_COMPACT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/**
 * PEM / private-key blocks (and SSH OPENSSH keys). Collapses the whole block
 * so a mis-filed note cannot ship key material in a CSV download (Loop 103).
 */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 -]+-----[\s\S]*?-----END [A-Z0-9 -]+-----/g;

/** Strip credential userinfo, PEMs, cookies, Basic/JWT, secret assignments. */
export function redactExportCell(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  if (!s) return s;
  s = s.replace(PEM_BLOCK, '[redacted-pem]');
  s = s.replace(URL_USERINFO, '//[redacted]@');
  s = s.replace(BEARER_AUTH, 'authorization=[redacted]');
  s = s.replace(BEARER_TOKEN, 'bearer [redacted]');
  s = s.replace(BASIC_AUTH_HEADER, 'authorization=[redacted]');
  s = s.replace(BASIC_BARE, 'basic [redacted]');
  s = s.replace(JWT_COMPACT, '[redacted-jwt]');
  s = s.replace(COOKIE_HEADER, 'set-cookie=[redacted]');
  s = s.replace(COOKIE_PAIR, 'cookie=[redacted]');
  s = s.replace(SECRET_ASSIGNMENT, '$1=[redacted]');
  return s;
}

/**
 * Neutralize spreadsheet formula injection (Loop 108).
 * Cells that open with `= + - @` or TAB/CR can execute when opened in Excel /
 * Sheets. Prefix a single quote so they stay text. Pure signed numbers
 * (`-12.5`, `+3e4`) stay intact so metric samples remain numeric-looking.
 */
export function neutralizeCsvFormula(s: string): string {
  if (!s) return s;
  const c = s[0];
  if (c !== '=' && c !== '+' && c !== '-' && c !== '@' && c !== '\t' && c !== '\r') {
    return s;
  }
  if ((c === '+' || c === '-') && /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    return s;
  }
  return `'${s}`;
}

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLines(header: string[], rows: unknown[][]): string {
  return (
    [
      header.join(','),
      ...rows.map((r) =>
        r.map((c) => csvEscape(neutralizeCsvFormula(redactExportCell(c)))).join(','),
      ),
    ].join('\n') + '\n'
  );
}

/**
 * Build Content-Disposition with both ASCII `filename=` and RFC 5987
 * `filename*=UTF-8''…` so browsers with non-ASCII fallbacks stay honest
 * (Loop 103). Filenames are sanitized to a single path segment.
 */
export function contentDispositionAttachment(filename: string): string {
  const base = String(filename || 'export.csv').replace(/[/\\]/g, '_').replace(/"/g, '');
  const ascii = base.replace(/[^\x20-\x7E]/g, '_') || 'export.csv';
  const star = encodeURIComponent(base);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

export function sendCsv(
  res: { setHeader: (k: string, v: string) => void; send: (b: string) => void },
  filename: string,
  header: string[],
  rows: unknown[][],
): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDispositionAttachment(filename));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.send(csvLines(header, rows));
}
