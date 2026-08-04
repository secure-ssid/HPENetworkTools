/**
 * Loop 55 / 103 / 105 / 108 — CSV export safety: cell redaction, formula
 * neutralization, and column contracts that must never ship secrets, note
 * bodies, PEMs, cookies, or vendor payloads.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  contentDispositionAttachment,
  csvLines,
  neutralizeCsvFormula,
  redactExportCell,
  sendCsv,
} from '../src/lib/csv';

describe('redactExportCell', () => {
  it('strips URL userinfo credentials', () => {
    expect(redactExportCell('https://u:p@hooks.example.com/x')).toBe(
      'https://[redacted]@hooks.example.com/x',
    );
    expect(redactExportCell('failed: fetch //admin:pw@10.0.0.1/path')).toBe(
      'failed: fetch //[redacted]@10.0.0.1/path',
    );
  });

  it('redacts secret-shaped assignments without touching bare labels', () => {
    expect(redactExportCell('password ok')).toBe('password ok');
    expect(redactExportCell('Authorization: Bearer abc.def')).toBe('authorization=[redacted]');
    expect(redactExportCell('bearer abc.def.ghi')).toBe('bearer [redacted]');
    expect(redactExportCell('api_key: super-secret')).toBe('api_key=[redacted]');
    expect(redactExportCell('token-switch-01 online')).toBe('token-switch-01 online');
    expect(redactExportCell('PSK set — redacted by the portal')).toBe(
      'PSK set — redacted by the portal',
    );
  });

  it('redacts PEM / private-key blocks (Loop 103)', () => {
    const pem = [
      'note before',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
      '-----END PRIVATE KEY-----',
      'note after',
    ].join('\n');
    const out = redactExportCell(pem);
    expect(out).toContain('[redacted-pem]');
    expect(out).toContain('note before');
    expect(out).toContain('note after');
    expect(out).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7');
  });

  it('redacts cookie header material without bare "cookie" labels (Loop 103)', () => {
    expect(redactExportCell('Cookie: session=abc123; path=/')).toBe('cookie=[redacted]');
    expect(redactExportCell('cookie=sid=xyz')).toBe('cookie=[redacted]');
    expect(redactExportCell('session cookie missing')).toBe('session cookie missing');
  });

  it('redacts Set-Cookie, Basic auth, and compact JWTs (Loop 105)', () => {
    expect(redactExportCell('Set-Cookie: SESSION=abc; Path=/')).toBe('set-cookie=[redacted]');
    expect(redactExportCell('Authorization: Basic dXNlcjpwYXNz')).toBe('authorization=[redacted]');
    expect(redactExportCell('basic YWRtaW46c2VjcmV0==')).toBe('basic [redacted]');
    expect(redactExportCell('basic connectivity ok')).toBe('basic connectivity ok');
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_segment_here';
    // Free-text embed (no `token=` assignment) — compact JWT shape alone redacts.
    expect(redactExportCell(`vendor said ${jwt} then failed`)).toBe(
      'vendor said [redacted-jwt] then failed',
    );
    expect(redactExportCell('device eyJ-not-a-jwt')).toBe('device eyJ-not-a-jwt');
  });

  it('csvLines applies redaction before escape', () => {
    const out = csvLines(
      ['url', 'err'],
      [['https://u:p@h/x', 'Authorization: Bearer tok.en']],
    );
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('u:p@');
    expect(out).not.toContain('tok.en');
  });
});

describe('neutralizeCsvFormula (Loop 108)', () => {
  it('prefixes spreadsheet formula lead-ins and leaves safe text/numbers', () => {
    expect(neutralizeCsvFormula('=cmd|"/c calc"!A0')).toBe(`'=cmd|"/c calc"!A0`);
    expect(neutralizeCsvFormula('+2+3')).toBe(`'+2+3`);
    expect(neutralizeCsvFormula('-@SUM(A1:A10)')).toBe(`'-@SUM(A1:A10)`);
    expect(neutralizeCsvFormula('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeCsvFormula('\t=1+1')).toBe(`'\t=1+1`);
    expect(neutralizeCsvFormula('\r=1+1')).toBe(`'\r=1+1`);
    // Pure signed numbers stay numeric-looking for metric samples.
    expect(neutralizeCsvFormula('-12.5')).toBe('-12.5');
    expect(neutralizeCsvFormula('+3e4')).toBe('+3e4');
    expect(neutralizeCsvFormula('ok')).toBe('ok');
    expect(neutralizeCsvFormula('')).toBe('');
  });

  it('csvLines applies formula neutralization after redaction', () => {
    const out = csvLines(['note'], [['=HYPERLINK("http://x","x")']]);
    // Quoted because the cell contains commas/quotes; leading ' still present.
    expect(out).toContain(`'=HYPERLINK`);
    expect(out.split('\n')[1]).toMatch(/^"'?=|^'/);
    const plain = csvLines(['v'], [['=1+1']]);
    expect(plain.split('\n')[1]).toBe(`'=1+1`);
  });
});

describe('contentDispositionAttachment (Loop 103)', () => {
  it('emits ASCII filename= and RFC 5987 filename*', () => {
    expect(contentDispositionAttachment('tickets.csv')).toBe(
      "attachment; filename=\"tickets.csv\"; filename*=UTF-8''tickets.csv",
    );
  });

  it('sanitizes path separators and quotes', () => {
    const d = contentDispositionAttachment('a/b\\"c.csv');
    expect(d).toContain('filename="a_b_c.csv"');
    expect(d).not.toContain('/');
    expect(d).not.toMatch(/filename="[^"]*\\/);
  });

  it('sendCsv sets dual Content-Disposition', () => {
    const headers: Record<string, string> = {};
    let body = '';
    sendCsv(
      {
        setHeader: (k, v) => {
          headers[k.toLowerCase()] = v;
        },
        send: (b) => {
          body = b;
        },
      },
      'systems-roster.csv',
      ['name'],
      [['central']],
    );
    expect(headers['content-type']).toMatch(/text\/csv/);
    expect(headers['content-disposition']).toContain('filename="systems-roster.csv"');
    expect(headers['content-disposition']).toContain("filename*=UTF-8''systems-roster.csv");
    expect(headers['cache-control']).toMatch(/no-cache/);
    expect(body).toMatch(/^name\ncentral\n$/);
  });
});

describe('export column safety contracts', () => {
  /** First balanced sendCsv(res, …) call in src (handles nested parens in mappers). */
  function sendCsvBlock(src: string): string {
    const start = src.search(/sendCsv\s*\(/);
    expect(start, 'expected a sendCsv( call').toBeGreaterThanOrEqual(0);
    let i = src.indexOf('(', start);
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          // include trailing semicolon when present
          let end = i + 1;
          while (end < src.length && /\s/.test(src[end]!)) end++;
          if (src[end] === ';') end++;
          return src.slice(start, end);
        }
      }
    }
    throw new Error('unbalanced sendCsv( call');
  }

  function headerFromBlock(block: string): string {
    // First array literal after sendCsv( is the header columns.
    const after = block.slice(block.indexOf('('));
    const headerM = after.match(/\[[\s\S]*?\]/);
    expect(headerM, 'expected sendCsv header array').toBeTruthy();
    return headerM![0];
  }

  function exportSlice(src: string, routePath: string): string {
    const idx = src.indexOf(routePath);
    expect(idx, `expected route ${routePath}`).toBeGreaterThan(-1);
    return src.slice(idx);
  }

  it('tickets export header omits notes/body/payload', async () => {
    // Static contract — keeps the ticketsScreen map honest if columns drift.
    // Loop 75/79: noteCount (length only) is allowed; note bodies are not.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/screens/ticketsScreen.ts'), 'utf8');
    expect(src).toMatch(/no note bodies/);
    const block = sendCsvBlock(src);
    expect(block).toContain("'id'");
    expect(block).toContain("'title'");
    expect(block).toContain("'inc'");
    expect(block).toContain("'noteCount'");
    // Header columns only — row mapper may read t.notes.length for the count.
    const header = headerFromBlock(block);
    expect(header).not.toMatch(/'notes?'\s*,/i);
    expect(header).not.toMatch(/'(body|payload|password|token|secret)'/);
    // Count-only access; never serialize note text/body fields.
    expect(block).toMatch(/t\.notes\.length|notes\)\s*\?\s*t\.notes\.length/);
    expect(block).not.toMatch(/t\.notes\.(?:map|join|text|body)|JSON\.stringify\s*\(\s*t\.notes/);
  });

  it('notifications deliveries export omits body/url/hmac', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/notifications.ts'), 'utf8');
    expect(src).toMatch(/Never includes payload bodies/);
    // Prefer the deliveries/export handler's sendCsv (file may have only one).
    const block = sendCsvBlock(exportSlice(src, "'/notifications/deliveries/export'"));
    expect(block).toContain("'endpoint'");
    expect(block).toContain("'result'");
    expect(block).not.toMatch(/\b(hmacSecret|payload|body|url)\b/);
  });

  it('systems roster export omits credentials/notes/call paths (Loop 100/103)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/screens/systemsScreen.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/systems/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'name'");
    expect(header).toContain("'health'");
    expect(header).toContain("'callsToday'");
    expect(header).not.toMatch(/'(password|secret|token|credential|note|notes|events|calls)'/);
    expect(block).not.toMatch(/\b(password|apiKey|clientSecret|hmacSecret)\b/);
  });

  it('metrics export ships count samples only (Loop 101/103)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/metrics.ts'), 'utf8');
    const slice = exportSlice(src, "'/metrics/export'");
    expect(slice).toMatch(/'scope'/);
    expect(slice).toMatch(/'metric'/);
    expect(slice).toMatch(/'t'/);
    expect(slice).toMatch(/'v'/);
    expect(slice).not.toMatch(/'(password|secret|token|payload|body|raw)'/);
  });

  it('diagnostics history export always redacts target (Loop 101/103)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/diagnostics.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/diagnostics/history/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'target'");
    expect(header).toContain("'operation'");
    expect(header).not.toMatch(/'(password|secret|token|payload|body|hops)'/);
    // Row must use the redacted target field from the service, not a free target.
    expect(block).toMatch(/e\.target/);
  });

  it('notification outbox + report exports omit payload/email bodies (Loop 101/103)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/notifications.ts'), 'utf8');

    const outbox = sendCsvBlock(exportSlice(src, "'/notifications/outbox/export'"));
    expect(outbox).toContain("'endpoint'");
    expect(outbox).toContain("'fingerprint'");
    expect(outbox).not.toMatch(/\b(payload|body|hmacSecret|url)\b/);

    const report = sendCsvBlock(exportSlice(src, "'/notifications/report/export'"));
    expect(report).toContain("'subject'");
    expect(report).toContain("'recipients'");
    expect(report).not.toMatch(/\b(text|html|body|payload)\b/);
  });

  it('visual-references export is metadata only — no binary/PEM columns (Loop 99/103)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/visualReferences.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/visual-references/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'title'");
    expect(header).toContain("'assetId'");
    expect(header).toContain("'mimeType'");
    expect(header).not.toMatch(/'(bytes|data|pem|content|body|payload|password|secret)'/);
  });

  it('hooks events export is summary-only — no payload/secret columns (Loop 108)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/hooks.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/hooks/events/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'id'");
    expect(header).toContain("'source'");
    expect(header).toContain("'eventType'");
    expect(header).not.toMatch(/'(payload|body|secret|hmac|signature|raw|headers)'/);
    expect(block).not.toMatch(/\b(payload|hmacSecret|rawBody|signingSecret)\b/);
  });

  it('central webhooks export omits secrets/HMAC (Loop 108)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/centralWebhooks.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/central/webhooks/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'id'");
    expect(header).toContain("'endpoint'");
    expect(header).toContain("'authMechanism'");
    expect(header).not.toMatch(/'(secret|hmac|password|token|payload|body)'/);
    expect(block).not.toMatch(/\b(hmacSecret|clientSecret|password)\b/);
  });

  it('config-backups export is roster metadata only — no config bodies (Loop 108)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/configBackups.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/config-backups/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'device'");
    expect(header).toContain("'status'");
    expect(header).toContain("'drift'");
    expect(header).not.toMatch(/'(config|body|payload|running|startup|password|secret|token)'/);
    expect(block).not.toMatch(/\b(configBody|runningConfig|startupConfig)\b/);
  });

  it('ssl-hosts export never ships PEMs or private keys (Loop 108)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../src/routes/notifications.ts'), 'utf8');
    const block = sendCsvBlock(exportSlice(src, "'/notifications/ssl-hosts/export'"));
    const header = headerFromBlock(block);
    expect(header).toContain("'host'");
    expect(header).toMatch(/'port'|port/);
    expect(header).not.toMatch(/'(pem|cert|certificate|key|private|password|secret|body|payload)'/);
  });

  it('every sendCsv header array omits secret-shaped column names (Loop 108)', () => {
    const SRC = join(__dirname, '../src');
    const BAD =
      /^['"]?(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|hmac|hmacSecret|payload|body|raw|pem|privateKey|credential)['"]?$/i;

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (name === 'node_modules' || name === 'dist') continue;
          out.push(...walk(full));
        } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    /** Collect string literals inside the first [...] after sendCsv(. */
    function headerLiterals(block: string): string[] {
      const after = block.slice(block.indexOf('('));
      const headerM = after.match(/\[[\s\S]*?\]/);
      if (!headerM) return [];
      return [...headerM[0].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '');
    }

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      let from = 0;
      while (true) {
        const start = src.indexOf('sendCsv(', from);
        if (start < 0) break;
        let i = src.indexOf('(', start);
        let depth = 0;
        let end = -1;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
        if (end < 0) break;
        const block = src.slice(start, end);
        for (const col of headerLiterals(block)) {
          if (BAD.test(col)) offenders.push(`${file}: ${col}`);
        }
        from = end;
      }
    }
    expect(offenders, `secret-shaped CSV columns:\n${offenders.join('\n')}`).toEqual([]);
  });
});
