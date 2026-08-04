/**
 * Systems section deep-link helpers (`?section=` + `#systems-section-…`).
 * Kept out of Systems.tsx so section modules can share without circular imports.
 */

/** In-page Systems sections operators can deep-link with `?section=` / hash. */
export const SYSTEMS_SECTIONS = [
  'portal',
  'identity',
  'assistant',
  'notifications',
  'runtime-debug',
] as const;
export type SystemsSectionKey = (typeof SYSTEMS_SECTIONS)[number];

/** Accept short aliases used in older or hand-typed share links. */
export function parseSystemsSection(raw: string | null | undefined): SystemsSectionKey | null {
  if (!raw) return null;
  const key = raw
    .replace(/^#/, '')
    .replace(/^systems-section-/, '')
    .trim()
    .toLowerCase();
  if (key === 'identity-provider' || key === 'idp' || key === 'oidc' || key === 'auth') {
    return 'identity';
  }
  if (key === 'runtime' || key === 'debug' || key === 'runtimedebug') return 'runtime-debug';
  if (key === 'notify' || key === 'webhooks') return 'notifications';
  if (key === 'chat' || key === 'ai') return 'assistant';
  if (key === 'settings' || key === 'prefs' || key === 'preferences') return 'portal';
  return (SYSTEMS_SECTIONS as readonly string[]).includes(key) ? (key as SystemsSectionKey) : null;
}

/** DOM id targeted by `?section=` scroll + share hash. */
export function systemsSectionDomId(section: SystemsSectionKey): string {
  return `systems-section-${section}`;
}

/** Clipboard URL that reopens one Systems section. */
export function buildSystemsSectionUrl(
  section: SystemsSectionKey,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/systems',
): string {
  const path = !pathname || pathname === '/' ? '/systems' : pathname;
  const next = new URLSearchParams();
  next.set('section', section);
  const hash = `#${systemsSectionDomId(section)}`;
  return `${origin}${path}?${next.toString()}${hash}`;
}
