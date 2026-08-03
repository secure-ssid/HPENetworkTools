/**
 * web/src/screens/central/style.ts — the one `noteStyle` the Central
 * screen's sections share (the same shape site-detail and the Mist screen
 * carry; re-homed here so this screen's sections do not each grow a copy).
 */

export const noteStyle = {
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 'var(--nd-text-11)',
  color: 'var(--nd-text-muted)',
  lineHeight: 1.6,
} as const;
