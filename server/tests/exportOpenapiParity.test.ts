/**
 * Loop 62 — every server route whose path matches /export must be listed in
 * OpenAPI paths and in the curated EXPECTED_EXPORTS catalog (kept in sync).
 *
 * Static source scan (no server boot): route registrations under server/src
 * vs openapi.ts path keys. Express :param → OpenAPI {param}; /api prefix.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const OPENAPI_FILE = join(SRC, 'routes', 'openapi.ts');

/**
 * Curated catalog of portal CSV export paths (OpenAPI form).
 * Update this when adding/removing a server `/export` route — the scan below
 * will fail until OpenAPI and this list agree with route registrations.
 */
export const EXPECTED_EXPORTS = [
  '/api/alert-rules/export',
  '/api/alerts/export',
  '/api/alerts/{fingerprint}/timeline/export',
  '/api/auth-events/export',
  '/api/central/export',
  '/api/central/webhooks/export',
  '/api/clearpass/export',
  '/api/clients/export',
  '/api/compliance/export',
  '/api/config-backups/export',
  '/api/configure/export',
  '/api/configure/history/export',
  '/api/debug/runtime/export',
  '/api/devices/export',
  '/api/devices/{name}/clients/export',
  '/api/devices/{name}/ports/export',
  '/api/devices/{name}/trends/export',
  '/api/diagnostics/history/export',
  '/api/greenlake/export',
  '/api/hooks/events/export',
  '/api/licenses/export',
  '/api/maintenance-windows/export',
  '/api/metrics/export',
  '/api/mist/audit-log/export',
  '/api/mist/export',
  '/api/notifications/deliveries/export',
  '/api/notifications/outbox/export',
  '/api/notifications/report/export',
  '/api/notifications/ssl-hosts/export',
  '/api/overview/export',
  '/api/recommendations/export',
  '/api/search-index/export',
  '/api/silences/export',
  '/api/sites/export',
  '/api/sites/{siteId}/applications/export',
  '/api/sites/{siteId}/rogues/export',
  '/api/sites/{siteId}/sle/export',
  '/api/sites/{siteId}/sle/{metric}/export',
  '/api/sse/objects/{kind}/export',
  '/api/systems/export',
  '/api/tickets/export',
  '/api/topology/export',
  '/api/uxi/export',
  '/api/visual-references/export',
] as const;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...walkTsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // and /* * / comments so quoted paths in comments are ignored. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isExportPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  // path segment is exactly "export" (not "exports", vendor noise, etc.)
  return path.split('/').includes('export');
}

/** Express route path → OpenAPI-style /api path. */
function toOpenApiPath(routePath: string): string {
  let p = routePath;
  if (!p.startsWith('/api/') && p !== '/api') {
    p = p.startsWith('/') ? `/api${p}` : `/api/${p}`;
  }
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/**
 * Collect path strings from Express-style registrations:
 *   router.get('/path', …)
 *   fooRouter.get(\n  '/path', …)
 */
function collectRegisteredPaths(src: string): string[] {
  const body = stripComments(src);
  const re = /\.(?:get|post|put|patch|delete|all)\(\s*['"]([^'"]+)['"]/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

function scanCodeExportRoutes(): string[] {
  const found = new Set<string>();
  for (const file of walkTsFiles(SRC)) {
    if (relative(SRC, file) === join('routes', 'openapi.ts')) continue;
    const paths = collectRegisteredPaths(readFileSync(file, 'utf8'));
    for (const path of paths) {
      if (!isExportPath(path)) continue;
      found.add(toOpenApiPath(path));
    }
  }
  return [...found].sort();
}

function openApiExportPaths(): string[] {
  const src = readFileSync(OPENAPI_FILE, 'utf8');
  // Path keys in the SPEC.paths object: ' /api/... ': {
  const keys = [...src.matchAll(/^\s+'(\/api\/[^']+)'\s*:\s*\{/gm)].map((m) => m[1]);
  return keys.filter((p) => p.split('/').includes('export')).sort();
}

function sortedUnique(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

describe('export ↔ OpenAPI parity (Loop 62)', () => {
  const codeExports = scanCodeExportRoutes();
  const openapiExports = openApiExportPaths();
  const expected = sortedUnique(EXPECTED_EXPORTS);

  it('EXPECTED_EXPORTS has no duplicates and is sorted for review', () => {
    expect([...EXPECTED_EXPORTS]).toEqual([...EXPECTED_EXPORTS].sort());
    expect(EXPECTED_EXPORTS.length).toBe(new Set(EXPECTED_EXPORTS).size);
  });

  it('every code /export route is in EXPECTED_EXPORTS', () => {
    const missing = codeExports.filter((p) => !expected.includes(p));
    expect(missing, `code export routes missing from EXPECTED_EXPORTS:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('every EXPECTED_EXPORTS entry is registered in code', () => {
    const extra = expected.filter((p) => !codeExports.includes(p));
    expect(extra, `EXPECTED_EXPORTS not found in route registrations:\n${extra.join('\n')}`).toEqual(
      [],
    );
  });

  it('every code /export route is listed in openapi paths', () => {
    const missing = codeExports.filter((p) => !openapiExports.includes(p));
    expect(missing, `code export routes missing from openapi.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every openapi /export path is registered in code', () => {
    const extra = openapiExports.filter((p) => !codeExports.includes(p));
    expect(extra, `openapi export paths with no route registration:\n${extra.join('\n')}`).toEqual([]);
  });

  it('EXPECTED_EXPORTS matches openapi export paths exactly', () => {
    expect(openapiExports).toEqual(expected);
  });

  it('EXPECTED_EXPORTS matches scanned code export routes exactly', () => {
    expect(codeExports).toEqual(expected);
  });
});


describe('export catalog ↔ docs parity (Loop 103)', () => {
  const DOCS_ROOT = join(ROOT, '..', 'docs');

  /** Paths docs may mention that are explicitly not portal CSV routes. */
  const DOCS_NON_ROUTES = new Set<string>([
    // Cookbook says there is no inventory export — devices export is the CSV.
    '/api/inventory/export',
  ]);

  function normalizeDocPath(raw: string): string {
    let p = raw.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    // Shorthand `{id}` in operator docs maps to OpenAPI `{siteId}` for site routes.
    p = p.replace('/api/sites/{id}/', '/api/sites/{siteId}/');
    return p;
  }

  function collectDocExportMentions(): string[] {
    const found = new Set<string>();
    // Paths appear as `/api/.../export` or `GET /api/.../export` in markdown.
    const re = /\/api\/[A-Za-z0-9_{}/-]*export/g;
    for (const name of ['ui-api-improvements-report.md', 'user-guide.md']) {
      const text = readFileSync(join(DOCS_ROOT, name), 'utf8');
      for (const m of text.matchAll(re)) {
        found.add(normalizeDocPath(m[0]));
      }
    }
    return [...found].sort();
  }

  it('EXPECTED_EXPORTS count stays at the documented catalog size', () => {
    // Bump this intentionally when adding/removing a server CSV route.
    expect(EXPECTED_EXPORTS.length).toBe(44);
  });

  it('docs mention every EXPECTED_EXPORTS path', () => {
    const docs = collectDocExportMentions();
    const missing = EXPECTED_EXPORTS.filter((p) => !docs.includes(p));
    expect(missing, `export paths missing from docs:\n${missing.join('\n')}`).toEqual([]);
  });

  it('docs do not invent export paths outside EXPECTED_EXPORTS', () => {
    const docs = collectDocExportMentions();
    const extra = docs.filter(
      (p) => !(EXPECTED_EXPORTS as readonly string[]).includes(p) && !DOCS_NON_ROUTES.has(p),
    );
    expect(extra, `docs export paths not in EXPECTED_EXPORTS:\n${extra.join('\n')}`).toEqual([]);
  });
});
