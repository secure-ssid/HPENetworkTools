/**
 * Mist section deep-link helpers (`?section=` + `#mist-section-…`).
 * Kept out of Mist.tsx so section modules can share without circular imports.
 */

/** In-page Mist sections operators can deep-link with `?section=` / hash. */
export const MIST_SECTIONS = [
  'sle',
  'rogues',
  'ap-health',
  'wlans',
  'devices',
  'licenses',
  'audit',
] as const;
export type MistSectionKey = (typeof MIST_SECTIONS)[number];

/** Accept short aliases used in older share links (`ap` → ap-health, `firmware` → devices). */
export function parseMistSection(raw: string | null | undefined): MistSectionKey | null {
  if (!raw) return null;
  const key = raw.replace(/^#/, '').replace(/^mist-section-/, '').trim().toLowerCase();
  if (key === 'ap' || key === 'aphealth' || key === 'ap_health') return 'ap-health';
  if (key === 'firmware' || key === 'device') return 'devices';
  if (key === 'license' || key === 'licence' || key === 'licences') return 'licenses';
  if (key === 'wlan' || key === 'ssid' || key === 'ssids') return 'wlans';
  if (key === 'rogue') return 'rogues';
  return (MIST_SECTIONS as readonly string[]).includes(key) ? (key as MistSectionKey) : null;
}

/** DOM id targeted by `?section=` scroll + share hash. */
export function mistSectionDomId(section: MistSectionKey): string {
  return `mist-section-${section}`;
}

/** Clipboard URL that reopens one Mist section (or the whole plane page). */
export function buildMistShareUrl(
  section: MistSectionKey | null,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/mist',
): string {
  /* Tests and odd embeds may sit at `/`; section shares always name the Mist route. */
  const path = !pathname || pathname === '/' ? '/mist' : pathname;
  const next = new URLSearchParams();
  if (section) next.set('section', section);
  const qs = next.toString();
  const hash = section ? `#${mistSectionDomId(section)}` : '';
  return `${origin}${path}${qs ? `?${qs}` : ''}${hash}`;
}
